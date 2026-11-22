import React, { useState, useRef, useEffect, useCallback, useMemo, useId } from 'react';
import { createPortal } from 'react-dom';
import {
  Settings,
  Pipette,
  Moon,
  Droplet,
  Sun,
  X,
  RotateCcw,
  Copy,
  Check,
  Pin,
  PinOff,
  Compass,
  Sparkles,
} from 'lucide-react';
import {
  HSV,
  RGB,
  hexToHsv,
  hexToRgb,
  hsvToHex,
  rgbToHex,
  isValidHex,
} from '../utils/colorUtils';
import {
  SphereColorResult,
  SphereColorSlot,
  SphereLightingConfig,
  SphereMarkerPosition,
  SphereSlotsState,
  SphereRenderLut,
  DEFAULT_SPHERE_LIGHTING,
  DEFAULT_SPHERE_SLOTS,
  SPHERE_LIGHTING_PRESETS,
  buildSphereGeometryLut,
  updateSphereLightingLut,
  renderSphereFromLut,
  evaluateSphereColor,
  clampMarkerPosition,
  projectSphereMarker,
  getLightVectors,
} from '../utils/sphereColorMath';
import { safeLocalStorageSetItem } from '../utils/safeStorage';

export interface SpherePickerSharedState {
  slots: SphereSlotsState;
  activeSlot: SphereColorSlot;
  lighting: SphereLightingConfig;
  marker: SphereMarkerPosition;
}

export interface SphereColorPickerProps {
  /** Initial / previous color shown on the left side of the top preview bar. */
  initialColor?: string;
  /** Fired whenever the sampled sphere color changes. Returns both HEX and RGB. */
  onColorChange?: (color: SphereColorResult, commit?: boolean) => void;
  /** Optional eyedropper callback (e.g. activates host app eyedropper tool). Falls back to browser EyeDropper API. */
  onEyedropper?: () => void;
  /** Optional close handler (renders close button in floating titlebar). */
  onClose?: () => void;
  /** Toggle between docked (inside ColorPanel) and floating (unpinned draggable) modes. */
  isPinned?: boolean;
  onTogglePin?: () => void;
  /** Layout variant: 'docked' fits narrow sidebar containers; 'floating' renders standalone studio palette. */
  variant?: 'docked' | 'floating';
  /** Auto-desaturate to B&W when true (e.g., grayscale/monochrome canvas). */
  monochromeDefault?: boolean;
  /** Diameter of the sphere viewport in CSS pixels (floating mode). Auto-measured in docked mode. */
  sphereSize?: number;
  /** Optional shared state so pin/unpin transitions preserve slots, light, and marker seamlessly. */
  sharedState?: SpherePickerSharedState;
  onSharedStateChange?: (state: SpherePickerSharedState) => void;
  /** Pointer down handler on the titlebar (used by floating draggable wrapper). */
  onHeaderDragStart?: (e: React.PointerEvent<HTMLDivElement>) => void;
  /** Additional container classes. */
  className?: string;
}

interface BrowserEyeDropper {
  open: () => Promise<{ sRGBHex: string }>;
}

const SPHERE_RADIUS_RATIO = 0.465;

const DEFAULT_RIM_SLOT: HSV = DEFAULT_SPHERE_SLOTS.rim ?? { h: 200, s: 0.28, v: 0.82 };

function getGeomLightKey(lighting: SphereLightingConfig): string {
  return `${lighting.lightAzimuth}|${lighting.lightElevation}|${lighting.roughness}|${lighting.specularStrength}|${lighting.bounceIntensity}|${lighting.shadowDepth}|${lighting.rimIntensity ?? DEFAULT_SPHERE_LIGHTING.rimIntensity}|${lighting.subsurface ?? DEFAULT_SPHERE_LIGHTING.subsurface}`;
}

export function buildHarmonizedSlots(initialHex?: string): SphereSlotsState {
  if (!initialHex || !isValidHex(initialHex)) {
    return {
      shadow: { ...DEFAULT_SPHERE_SLOTS.shadow },
      base: { ...DEFAULT_SPHERE_SLOTS.base },
      light: { ...DEFAULT_SPHERE_SLOTS.light },
      rim: { ...DEFAULT_RIM_SLOT },
    };
  }
  const baseHsv = hexToHsv(initialHex);
  const hasChroma = baseHsv.s > 0.05 && baseHsv.v > 0.08;
  const h = hasChroma ? baseHsv.h : DEFAULT_SPHERE_SLOTS.base.h;
  return {
    base: {
      h,
      s: hasChroma ? Math.max(0.08, Math.min(1, baseHsv.s)) : DEFAULT_SPHERE_SLOTS.base.s,
      v: hasChroma ? Math.max(0.22, Math.min(0.98, baseHsv.v)) : DEFAULT_SPHERE_SLOTS.base.v,
    },
    shadow: {
      h: (h + 38) % 360,
      s: hasChroma ? Math.min(0.75, Math.max(0.24, baseHsv.s * 0.85)) : DEFAULT_SPHERE_SLOTS.shadow.s,
      v: 0.42,
    },
    light: {
      h: (h + 332) % 360,
      s: hasChroma ? Math.min(0.42, Math.max(0.1, baseHsv.s * 0.48)) : DEFAULT_SPHERE_SLOTS.light.s,
      v: 0.96,
    },
    rim: {
      h: (h + 344) % 360,
      s: hasChroma ? Math.min(0.88, Math.max(0.28, baseHsv.s * 0.92)) : DEFAULT_RIM_SLOT.s,
      v: 0.92,
    },
  };
}

export function createInitialSphereState(
  initialColor?: string,
  monochromeDefault = false
): SpherePickerSharedState {
  return {
    slots: buildHarmonizedSlots(initialColor),
    activeSlot: 'base',
    lighting: {
      ...DEFAULT_SPHERE_LIGHTING,
      saturation: monochromeDefault ? 0 : DEFAULT_SPHERE_LIGHTING.saturation,
    },
    marker: { x: -0.22, y: 0.28 },
  };
}

function darkenRgb(rgb: RGB, factor: number): string {
  return rgbToHex(rgb.r * factor, rgb.g * factor, rgb.b * factor);
}

function lightenRgb(rgb: RGB, amount: number): string {
  return rgbToHex(
    rgb.r + (255 - rgb.r) * amount,
    rgb.g + (255 - rgb.g) * amount,
    rgb.b + (255 - rgb.b) * amount
  );
}

/** Studio-styled 60fps pointer-captured linear slider matching Ink Studio's flat dark palette */
interface MiniBarSliderProps {
  label: string;
  value: number;
  min: number;
  max: number;
  displayValue: string;
  gradient: string;
  onChange: (value: number, commit?: boolean) => void;
  rightAction?: React.ReactNode;
  compact?: boolean;
  testId?: string;
}

const MiniBarSlider: React.FC<MiniBarSliderProps> = ({
  label,
  value,
  min,
  max,
  displayValue,
  gradient,
  onChange,
  rightAction,
  compact = false,
  testId,
}) => {
  const trackRef = useRef<HTMLDivElement | null>(null);
  const draggingRef = useRef(false);

  const emitFromX = (clientX: number, commit: boolean) => {
    const el = trackRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    if (rect.width <= 0) return;
    const ratio = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
    onChange(min + ratio * (max - min), commit);
  };

  const percent = Math.max(0, Math.min(100, ((value - min) / (max - min)) * 100));

  return (
    <div className="flex items-center gap-1.5">
      <span
        className={`${compact ? 'w-7 text-[9.5px]' : 'w-11 text-[10px]'} text-[#8a8a8a] shrink-0`}
      >
        {label}
      </span>
      <div
        role="slider"
        tabIndex={0}
        aria-label={label}
        aria-valuemin={min}
        aria-valuemax={max}
        aria-valuenow={Math.round(value * 100) / 100}
        data-testid={testId}
        onPointerDown={(e) => {
          e.preventDefault();
          draggingRef.current = true;
          e.currentTarget.setPointerCapture(e.pointerId);
          emitFromX(e.clientX, false);
        }}
        onPointerMove={(e) => {
          if (!draggingRef.current) return;
          emitFromX(e.clientX, false);
        }}
        onPointerUp={(e) => {
          if (!draggingRef.current) return;
          if (e.currentTarget.hasPointerCapture(e.pointerId)) {
            e.currentTarget.releasePointerCapture(e.pointerId);
          }
          draggingRef.current = false;
          emitFromX(e.clientX, true);
        }}
        onPointerCancel={(e) => {
          if (!draggingRef.current) return;
          draggingRef.current = false;
          if (e.currentTarget.hasPointerCapture(e.pointerId)) {
            e.currentTarget.releasePointerCapture(e.pointerId);
          }
        }}
        onKeyDown={(e) => {
          const step = (max - min) * (e.shiftKey ? 0.1 : 0.02);
          if (e.key === 'ArrowRight' || e.key === 'ArrowUp') {
            e.preventDefault();
            onChange(Math.min(max, value + step), true);
          } else if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') {
            e.preventDefault();
            onChange(Math.max(min, value - step), true);
          }
        }}
        className="flex-1 h-4 flex items-center cursor-pointer touch-none outline-none focus-visible:ring-1 focus-visible:ring-[var(--accent-border)] rounded-xs px-0.5"
      >
        <div
          ref={trackRef}
          className="relative w-full h-[5px] rounded-[2px] border border-white/[0.08]"
          style={{ background: gradient }}
        >
          <div
            style={{ left: `${percent}%` }}
            className="absolute top-1/2 -translate-x-1/2 -translate-y-1/2 w-2.5 h-3 rounded-[2px] bg-[#e5e5e5] border border-[#161616] shadow-[0_1px_3px_rgba(0,0,0,0.75)] pointer-events-none"
          />
        </div>
      </div>
      <span
        className={`${compact ? 'w-7 text-[9.5px]' : 'w-8 text-[10px]'} font-mono text-right text-[#cccccc] tabular-nums shrink-0`}
      >
        {displayValue}
      </span>
      {rightAction}
    </div>
  );
};

export const SphereColorPicker: React.FC<SphereColorPickerProps> = ({
  initialColor = '#85988E',
  onColorChange,
  onEyedropper,
  onClose,
  isPinned = false,
  onTogglePin,
  variant = 'floating',
  monochromeDefault = false,
  sphereSize: sphereSizeProp = 224,
  sharedState,
  onSharedStateChange,
  onHeaderDragStart,
  className = '',
}) => {
  const isDocked = variant === 'docked';

  const [previousColor] = useState<string>(() =>
    isValidHex(initialColor)
      ? initialColor.startsWith('#')
        ? initialColor.toUpperCase()
        : `#${initialColor.toUpperCase()}`
      : '#85988E'
  );

  const [internalState, setInternalState] = useState<SpherePickerSharedState>(() =>
    sharedState ?? createInitialSphereState(initialColor, monochromeDefault)
  );

  const state = sharedState ?? internalState;
  const { slots, activeSlot, lighting, marker } = state;

  const commitState = useCallback(
    (next: SpherePickerSharedState) => {
      if (onSharedStateChange) {
        onSharedStateChange(next);
      } else {
        setInternalState(next);
      }
    },
    [onSharedStateChange]
  );

  const [showSettings, setShowSettings] = useState(false);
  const [lightOrbitMode, setLightOrbitMode] = useState(false);
  const [isOrbitingLight, setIsOrbitingLight] = useState(false);
  const [copiedField, setCopiedField] = useState<'hex' | 'rgb' | null>(null);
  const lastNonZeroSatRef = useRef<number>(lighting.saturation > 0.05 ? lighting.saturation : 1.0);
  const shadowFilterId = useId();

  const rootRef = useRef<HTMLDivElement | null>(null);
  const [measuredWidth, setMeasuredWidth] = useState<number>(isDocked ? 200 : sphereSizeProp + 48);

  useEffect(() => {
    if (!isDocked) return;
    const el = rootRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      for (const entry of entries) {
        if (entry.contentRect.width > 0) {
          setMeasuredWidth(Math.round(entry.contentRect.width));
        }
      }
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [isDocked]);

  const compact = isDocked && measuredWidth < 245;
  const effectiveSphereSize = isDocked
    ? Math.max(108, Math.min(212, measuredWidth - (compact ? 20 : 32)))
    : sphereSizeProp;

  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const lutRef = useRef<SphereRenderLut | null>(null);
  const hueTrackRef = useRef<HTMLDivElement | null>(null);
  const dragModeRef = useRef<'marker' | 'light' | null>(null);
  const hueDraggingRef = useRef(false);
  const rafRenderRef = useRef<number | null>(null);

  const stateRef = useRef(state);
  stateRef.current = state;

  const prevGeomLightKeyRef = useRef<string>('');

  const sampledColor = useMemo<SphereColorResult>(
    () => evaluateSphereColor(marker, slots, lighting),
    [marker, slots, lighting]
  );

  const projectedMarker = useMemo(
    () => projectSphereMarker(marker, effectiveSphereSize, SPHERE_RADIUS_RATIO, lighting),
    [marker, effectiveSphereSize, lighting]
  );

  // Build geometry LUT on resize / DPR change
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const pxSize = Math.max(108, Math.round(effectiveSphereSize * dpr));
    canvas.width = pxSize;
    canvas.height = pxSize;

    const lut = buildSphereGeometryLut(pxSize, pxSize, SPHERE_RADIUS_RATIO);
    updateSphereLightingLut(lut, stateRef.current.lighting);
    lutRef.current = lut;
    prevGeomLightKeyRef.current = getGeomLightKey(stateRef.current.lighting);

    const ctx = canvas.getContext('2d');
    if (ctx) {
      renderSphereFromLut(ctx, lut, stateRef.current.slots, stateRef.current.lighting);
    }
  }, [effectiveSphereSize]);

  // Recompute lighting LUT only when geometric lighting params change
  useEffect(() => {
    const lut = lutRef.current;
    if (!lut) return;
    const key = getGeomLightKey(lighting);
    if (key !== prevGeomLightKeyRef.current) {
      prevGeomLightKeyRef.current = key;
      updateSphereLightingLut(lut, lighting);
    }
  }, [lighting]);

  // Schedule 60fps redraw on slot or lighting changes (NOT on marker drag)
  useEffect(() => {
    if (rafRenderRef.current !== null) {
      cancelAnimationFrame(rafRenderRef.current);
    }
    rafRenderRef.current = requestAnimationFrame(() => {
      rafRenderRef.current = null;
      const canvas = canvasRef.current;
      const lut = lutRef.current;
      if (!canvas || !lut) return;
      const ctx = canvas.getContext('2d');
      if (!ctx) return;
      renderSphereFromLut(ctx, lut, slots, lighting);
    });
    return () => {
      if (rafRenderRef.current !== null) {
        cancelAnimationFrame(rafRenderRef.current);
        rafRenderRef.current = null;
      }
    };
  }, [slots, lighting]);

  const emitColor = useCallback(
    (nextState: SpherePickerSharedState, commit = false) => {
      if (!onColorChange) return;
      const result = evaluateSphereColor(nextState.marker, nextState.slots, nextState.lighting);
      onColorChange(result, commit);
    },
    [onColorChange]
  );

  const computeSphereCoords = useCallback((clientX: number, clientY: number) => {
    const canvas = canvasRef.current;
    if (!canvas) return null;
    const rect = canvas.getBoundingClientRect();
    const radius = rect.width * SPHERE_RADIUS_RATIO;
    if (radius <= 0) return null;
    const cx = rect.left + rect.width * 0.5;
    const cy = rect.top + rect.height * 0.5;
    return {
      x: (clientX - cx) / radius,
      y: (cy - clientY) / radius,
    };
  }, []);

  const updateLightFromCoords = useCallback(
    (x: number, y: number, commit = false) => {
      const clamped = clampMarkerPosition(x, y, 0.96);
      const z = Math.sqrt(Math.max(0.01, 1 - clamped.x * clamped.x - clamped.y * clamped.y));
      const lightElevation = Math.round(
        (Math.asin(Math.max(-0.98, Math.min(0.98, clamped.y))) * 180) / Math.PI
      );
      const lightAzimuth = Math.round((Math.atan2(clamped.x, z) * 180) / Math.PI);
      const prev = stateRef.current;
      const next: SpherePickerSharedState = {
        ...prev,
        lighting: { ...prev.lighting, lightAzimuth, lightElevation },
      };
      commitState(next);
      emitColor(next, commit);
    },
    [commitState, emitColor]
  );

  const handleSpherePointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    e.preventDefault();
    const canvas = canvasRef.current;
    if (!canvas) return;
    canvas.setPointerCapture(e.pointerId);

    const coords = computeSphereCoords(e.clientX, e.clientY);
    if (!coords) return;

    if (lightOrbitMode || e.button === 2 || e.shiftKey) {
      dragModeRef.current = 'light';
      setIsOrbitingLight(true);
      updateLightFromCoords(coords.x, coords.y, false);
      return;
    }

    dragModeRef.current = 'marker';
    const prev = stateRef.current;
    const next: SpherePickerSharedState = {
      ...prev,
      marker: clampMarkerPosition(coords.x, coords.y),
    };
    commitState(next);
    emitColor(next, false);
  };

  const handleSpherePointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!dragModeRef.current) return;
    const coords = computeSphereCoords(e.clientX, e.clientY);
    if (!coords) return;

    if (dragModeRef.current === 'light') {
      updateLightFromCoords(coords.x, coords.y, false);
    } else {
      const prev = stateRef.current;
      const next: SpherePickerSharedState = {
        ...prev,
        marker: clampMarkerPosition(coords.x, coords.y),
      };
      commitState(next);
      emitColor(next, false);
    }
  };

  const handleSpherePointerUp = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!dragModeRef.current) return;
    const canvas = canvasRef.current;
    if (canvas && canvas.hasPointerCapture(e.pointerId)) {
      canvas.releasePointerCapture(e.pointerId);
    }
    dragModeRef.current = null;
    setIsOrbitingLight(false);
    emitColor(stateRef.current, true);
  };

  const updateActiveSlot = useCallback(
    (patch: Partial<HSV>, commit = false) => {
      const prev = stateRef.current;
      const currentHsv =
        prev.activeSlot === 'rim'
          ? (prev.slots.rim ?? DEFAULT_RIM_SLOT)
          : prev.slots[prev.activeSlot];
      const next: SpherePickerSharedState = {
        ...prev,
        slots: {
          ...prev.slots,
          [prev.activeSlot]: { ...currentHsv, ...patch },
        },
      };
      commitState(next);
      emitColor(next, commit);
    },
    [commitState, emitColor]
  );

  const applyPreset = useCallback(
    (presetId: string) => {
      const preset = SPHERE_LIGHTING_PRESETS.find((p) => p.id === presetId);
      if (!preset) return;
      const prev = stateRef.current;
      const nextLighting: SphereLightingConfig = { ...prev.lighting, ...preset.lighting };
      const nextSlots: SphereSlotsState = preset.slots
        ? {
            shadow: preset.slots.shadow ? { ...preset.slots.shadow } : prev.slots.shadow,
            base: preset.slots.base ? { ...preset.slots.base } : prev.slots.base,
            light: preset.slots.light ? { ...preset.slots.light } : prev.slots.light,
            rim: preset.slots.rim ? { ...preset.slots.rim } : (prev.slots.rim ?? { ...DEFAULT_RIM_SLOT }),
          }
        : prev.slots;
      const nextState: SpherePickerSharedState = {
        ...prev,
        lighting: nextLighting,
        slots: nextSlots,
      };
      commitState(nextState);
      emitColor(nextState, true);
    },
    [commitState, emitColor]
  );

  const updateLighting = useCallback(
    (patch: Partial<SphereLightingConfig>, commit = false) => {
      const prev = stateRef.current;
      if (patch.saturation !== undefined && patch.saturation > 0.05) {
        lastNonZeroSatRef.current = patch.saturation;
      }
      const next: SpherePickerSharedState = {
        ...prev,
        lighting: { ...prev.lighting, ...patch },
      };
      commitState(next);
      emitColor(next, commit);
    },
    [commitState, emitColor]
  );

  const updateHueFromClientX = useCallback(
    (clientX: number, commit = false) => {
      const track = hueTrackRef.current;
      if (!track) return;
      const rect = track.getBoundingClientRect();
      if (rect.width <= 0) return;
      const ratio = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
      const hue = Math.round(ratio * 359);
      updateActiveSlot({ h: hue }, commit);
    },
    [updateActiveSlot]
  );

  const handleHuePointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    hueDraggingRef.current = true;
    e.currentTarget.setPointerCapture(e.pointerId);
    updateHueFromClientX(e.clientX, false);
  };

  const handleHuePointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!hueDraggingRef.current) return;
    updateHueFromClientX(e.clientX, false);
  };

  const handleHuePointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!hueDraggingRef.current) return;
    if (e.currentTarget.hasPointerCapture(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId);
    }
    hueDraggingRef.current = false;
    updateHueFromClientX(e.clientX, true);
  };

  const handleHueKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    const step = e.shiftKey ? 10 : 1;
    const currentSlot = activeSlot === 'rim' ? (slots.rim ?? DEFAULT_RIM_SLOT) : slots[activeSlot];
    const currentHue = Math.round(currentSlot.h);
    if (e.key === 'ArrowRight' || e.key === 'ArrowUp') {
      e.preventDefault();
      updateActiveSlot({ h: (currentHue + step) % 360 }, true);
    } else if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') {
      e.preventDefault();
      updateActiveSlot({ h: (currentHue - step + 360) % 360 }, true);
    }
  };

  const handleEyedropperClick = async () => {
    if (onEyedropper) {
      onEyedropper();
      return;
    }
    const win = window as unknown as { EyeDropper?: new () => BrowserEyeDropper };
    if (typeof win.EyeDropper === 'function') {
      try {
        const dropper = new win.EyeDropper();
        const result = await dropper.open();
        if (result?.sRGBHex && isValidHex(result.sRGBHex)) {
          const pickedHsv = hexToHsv(result.sRGBHex);
          updateActiveSlot(pickedHsv, true);
        }
      } catch {
        // User cancelled native eyedropper
      }
    }
  };

  const handleRevertToPrevious = () => {
    const prev = stateRef.current;
    const next: SpherePickerSharedState = {
      ...prev,
      slots: buildHarmonizedSlots(previousColor),
    };
    commitState(next);
    if (onColorChange) {
      const rgb = hexToRgb(previousColor);
      onColorChange({ hex: rgbToHex(rgb.r, rgb.g, rgb.b), rgb }, true);
    }
  };

  const handleToggleBw = () => {
    const isBw = lighting.saturation <= 0.01;
    updateLighting({ saturation: isBw ? lastNonZeroSatRef.current || 1.0 : 0 }, true);
  };

  const handleCopy = (field: 'hex' | 'rgb') => {
    const text =
      field === 'hex'
        ? sampledColor.hex
        : `rgb(${sampledColor.rgb.r}, ${sampledColor.rgb.g}, ${sampledColor.rgb.b})`;
    navigator.clipboard?.writeText(text).catch(() => {});
    setCopiedField(field);
    setTimeout(() => setCopiedField((prev) => (prev === field ? null : prev)), 1200);
  };

  const rimSlotHsv = slots.rim ?? DEFAULT_RIM_SLOT;
  const activeSlotHsv = activeSlot === 'rim' ? rimSlotHsv : slots[activeSlot];
  const activeHue = Math.round(((activeSlotHsv.h % 360) + 360) % 360);
  const huePercent = (activeHue / 359) * 100;

  const shadowHex = hsvToHex(slots.shadow.h, slots.shadow.s, slots.shadow.v);
  const baseHex = hsvToHex(slots.base.h, slots.base.s, slots.base.v);
  const lightHex = hsvToHex(slots.light.h, slots.light.s, slots.light.v);
  const rimHex = hsvToHex(rimSlotHsv.h, rimSlotHsv.s, rimSlotHsv.v);
  const activeSlotHex = hsvToHex(activeSlotHsv.h, activeSlotHsv.s, activeSlotHsv.v);

  const puckTopHex = sampledColor.hex;
  const puckSideHex = darkenRgb(sampledColor.rgb, 0.64);
  const puckRimHex = lightenRgb(sampledColor.rgb, 0.28);

  const isBwMode = lighting.saturation <= 0.01;
  const satGradient = `linear-gradient(to right, #6e6e6e 0%, ${hsvToHex(slots.base.h, 0.72, 0.78)} 68%, ${hsvToHex(slots.base.h, 1, 0.92)} 100%)`;
  const lightGradient = `linear-gradient(to right, #161616 0%, ${lightHex} 55%, #ffffff 100%)`;
  const ambientGradient = `linear-gradient(to right, #101010 0%, ${baseHex} 55%, #f5f5f5 100%)`;
  const slotSatGradient = `linear-gradient(to right, ${hsvToHex(activeHue, 0, Math.max(0.25, activeSlotHsv.v))} 0%, ${hsvToHex(activeHue, 1, Math.max(0.35, activeSlotHsv.v))} 100%)`;
  const slotValGradient = `linear-gradient(to right, #080808 0%, ${hsvToHex(activeHue, activeSlotHsv.s, 1)} 100%)`;

  const ambientVal = lighting.ambientIntensity ?? DEFAULT_SPHERE_LIGHTING.ambientIntensity ?? 0.08;
  const lightTintVal = lighting.lightTint ?? DEFAULT_SPHERE_LIGHTING.lightTint ?? 0.28;
  const rimIntensityVal = lighting.rimIntensity ?? DEFAULT_SPHERE_LIGHTING.rimIntensity ?? 0.14;
  const subsurfaceVal = lighting.subsurface ?? DEFAULT_SPHERE_LIGHTING.subsurface ?? 0.16;

  const lightVec = useMemo(() => getLightVectors(lighting), [lighting]);
  const sphereR = effectiveSphereSize * SPHERE_RADIUS_RATIO;
  const lightReticleX = effectiveSphereSize * 0.5 + lightVec.lx * sphereR * 0.88;
  const lightReticleY = effectiveSphereSize * 0.5 - lightVec.ly * sphereR * 0.88;

  return (
    <div
      ref={rootRef}
      className={
        isDocked
          ? `w-full h-full flex flex-col bg-[#202020] text-[#e5e5e5] select-none overflow-y-auto overflow-x-hidden ${className}`
          : `bg-[#202020]/96 backdrop-blur-md text-[#e5e5e5] rounded-lg border border-white/[0.1] shadow-[0_12px_36px_rgba(0,0,0,0.65)] select-none overflow-hidden flex flex-col ${className}`
      }
      onPointerDown={(e) => e.stopPropagation()}
    >
      {/* Floating Studio Palette Title Bar (matches DockWorkspace h-6 #1a1a1a chrome) */}
      {!isDocked && (
        <div
          onPointerDown={onHeaderDragStart}
          title="Drag to move palette"
          className="h-6 px-2 flex items-center justify-between bg-[#1a1a1a] border-b border-white/[0.06] cursor-grab active:cursor-grabbing shrink-0"
        >
          <div className="flex items-center gap-1.5 min-w-0">
            <span
              className="w-2.5 h-2.5 rounded-full shrink-0"
              style={{
                background:
                  'radial-gradient(circle at 32% 30%, #f5f5f5 0%, #9ca3af 50%, #262930 100%)',
              }}
            />
            <span className="text-[10px] font-medium text-[#e5e5e5] tracking-wide truncate">
              Color Sphere
            </span>
          </div>

          <div
            className="flex items-center gap-0.5 shrink-0"
            onPointerDown={(e) => e.stopPropagation()}
          >
            {onTogglePin && (
              <button
                type="button"
                onClick={onTogglePin}
                data-testid="sphere-pin-toggle"
                title={isPinned ? 'Unpin & Float Palette' : 'Pin back to Color Panel'}
                aria-label={isPinned ? 'Unpin panel' : 'Pin panel'}
                className="w-5 h-5 rounded flex items-center justify-center text-[#8a8a8a] hover:text-[#e5e5e5] hover:bg-[#2c2c2c] transition-colors cursor-pointer"
              >
                {isPinned ? <PinOff className="w-3 h-3" /> : <Pin className="w-3 h-3" />}
              </button>
            )}
            {onClose && (
              <button
                type="button"
                onClick={onClose}
                title="Close (Esc)"
                aria-label="Close"
                className="w-5 h-5 rounded flex items-center justify-center text-[#8a8a8a] hover:text-[#e5e5e5] hover:bg-[#2c2c2c] transition-colors cursor-pointer"
              >
                <X className="w-3 h-3" />
              </button>
            )}
          </div>
        </div>
      )}

      {/* Top Controls Bar: Gear + Light Orbit | Split Preview Bar | Eyedropper (+ Unpin when docked) */}
      <div
        className={`${compact ? 'px-2 pt-1.5 pb-1 gap-1.5' : 'px-2.5 pt-2 pb-1.5 gap-2'} flex items-center justify-between border-b border-white/[0.06] shrink-0`}
      >
        <div className="flex items-center gap-0.5 shrink-0">
          <button
            type="button"
            onClick={() => setShowSettings((s) => !s)}
            title="Lighting & Surface Settings"
            aria-label="Lighting Settings"
            aria-expanded={showSettings}
            className={`w-6 h-6 rounded flex items-center justify-center transition-colors cursor-pointer ${
              showSettings
                ? 'bg-[var(--accent-subtle)] text-[var(--accent)] ring-1 ring-[var(--accent-border)]'
                : 'text-[#8a8a8a] hover:text-[#e5e5e5] hover:bg-[#2c2c2c]'
            }`}
          >
            <Settings className="w-3.5 h-3.5" />
          </button>

          <button
            type="button"
            onClick={() => setLightOrbitMode((m) => !m)}
            title={
              lightOrbitMode
                ? 'Light Orbit Active (drag sphere to angle light)'
                : 'Rotate Light Source (or Shift+drag on sphere)'
            }
            aria-label="Toggle Light Orbit Mode"
            aria-pressed={lightOrbitMode}
            className={`w-6 h-6 rounded flex items-center justify-center transition-colors cursor-pointer ${
              lightOrbitMode
                ? 'bg-[var(--accent-subtle)] text-[var(--accent)] ring-1 ring-[var(--accent-border)]'
                : 'text-[#8a8a8a] hover:text-[#e5e5e5] hover:bg-[#2c2c2c]'
            }`}
          >
            <Compass className="w-3.5 h-3.5" />
          </button>
        </div>

        {/* Split Preview Bar: Left = previous color, Right = live picked 3D sphere color */}
        <div className="flex-1 h-5 rounded-sm overflow-hidden flex border border-white/[0.1] bg-[#161616] min-w-[44px]">
          <button
            type="button"
            onClick={handleRevertToPrevious}
            title={`Previous: ${previousColor} (Click to revert)`}
            aria-label={`Previous color ${previousColor}`}
            className="flex-1 h-full cursor-pointer transition-opacity hover:opacity-90"
            style={{ backgroundColor: previousColor }}
          />
          <div
            data-testid="sphere-live-preview"
            title={`Current: ${sampledColor.hex} | rgb(${sampledColor.rgb.r}, ${sampledColor.rgb.g}, ${sampledColor.rgb.b})`}
            className="flex-1 h-full border-l border-black/35"
            style={{ backgroundColor: sampledColor.hex }}
          />
        </div>

        <div className="flex items-center gap-0.5 shrink-0">
          <button
            type="button"
            onClick={handleEyedropperClick}
            title="Eyedropper"
            aria-label="Eyedropper"
            className="w-6 h-6 rounded flex items-center justify-center text-[#8a8a8a] hover:text-[#e5e5e5] hover:bg-[#2c2c2c] transition-colors cursor-pointer"
          >
            <Pipette className="w-3.5 h-3.5" />
          </button>

          {isDocked && onTogglePin && (
            <button
              type="button"
              onClick={onTogglePin}
              data-testid="sphere-pin-toggle"
              title="Unpin & Float Palette"
              aria-label="Unpin panel"
              className="w-6 h-6 rounded flex items-center justify-center text-[#8a8a8a] hover:text-[#e5e5e5] hover:bg-[#2c2c2c] transition-colors cursor-pointer"
            >
              <PinOff className="w-3.5 h-3.5" />
            </button>
          )}
        </div>
      </div>

      {/* Collapsible Lighting & Surface Fine-Tune Drawer */}
      {showSettings && (
        <div
          className={`${compact ? 'mx-2 p-2' : 'mx-2.5 p-2'} mt-1.5 rounded-md bg-[#161616] border border-white/[0.06] space-y-2 text-[10px] shrink-0`}
        >
          <div className="flex items-center justify-between border-b border-white/[0.06] pb-1">
            <span className="text-[10px] font-medium text-[#cccccc]">Lighting &amp; Surface</span>
            <button
              type="button"
              onClick={() => {
                const resetState = createInitialSphereState(previousColor, monochromeDefault);
                commitState(resetState);
                emitColor(resetState, true);
              }}
              title="Reset Lighting"
              className="flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] text-[#8a8a8a] hover:text-[#e5e5e5] hover:bg-[#2c2c2c] cursor-pointer transition-colors"
            >
              <RotateCcw className="w-2.5 h-2.5" />
              <span>Reset</span>
            </button>
          </div>

          <div className="grid grid-cols-2 gap-1">
            {SPHERE_LIGHTING_PRESETS.map((preset) => (
              <button
                key={preset.id}
                type="button"
                data-testid={`sphere-preset-${preset.id}`}
                onClick={() => applyPreset(preset.id)}
                className="flex items-center gap-1.5 px-1.5 py-1 rounded bg-[#202020] hover:bg-[#2c2c2c] border border-white/[0.06] text-[10px] text-[#cccccc] hover:text-[#e5e5e5] text-left truncate cursor-pointer transition-colors"
              >
                {preset.swatch && (
                  <span
                    className="w-2 h-2 rounded-full shrink-0 ring-1 ring-white/20"
                    style={{ backgroundColor: preset.swatch }}
                  />
                )}
                <span className="truncate">{preset.label}</span>
              </button>
            ))}
          </div>

          <div className="pt-1 border-t border-white/[0.06] space-y-1">
            <div className="flex items-center justify-between gap-2">
              <span className="text-[10px] text-[#8a8a8a] w-14">Key Tint</span>
              <input
                type="range"
                min={0}
                max={100}
                value={Math.round(lightTintVal * 100)}
                onChange={(e) => updateLighting({ lightTint: Number(e.target.value) / 100 }, true)}
                className="flex-1"
                aria-label="Key Light Color Tint"
              />
              <span className="font-mono text-[10px] w-7 text-right text-[#e5e5e5]">
                {Math.round(lightTintVal * 100)}
              </span>
            </div>
            <div className="flex items-center justify-between gap-2">
              <span className="text-[10px] text-[#8a8a8a] w-14">Rim Glow</span>
              <input
                type="range"
                min={0}
                max={150}
                value={Math.round(rimIntensityVal * 100)}
                onChange={(e) => updateLighting({ rimIntensity: Number(e.target.value) / 100 }, true)}
                className="flex-1"
                aria-label="Rim Light Intensity"
              />
              <span className="font-mono text-[10px] w-7 text-right text-[#e5e5e5]">
                {Math.round(rimIntensityVal * 100)}
              </span>
            </div>
            <div className="flex items-center justify-between gap-2">
              <span className="text-[10px] text-[#8a8a8a] w-14">Gloss</span>
              <input
                type="range"
                min={5}
                max={95}
                value={Math.round((1 - lighting.roughness) * 100)}
                onChange={(e) => updateLighting({ roughness: 1 - Number(e.target.value) / 100 }, true)}
                className="flex-1"
                aria-label="Surface Gloss"
              />
              <span className="font-mono text-[10px] w-7 text-right text-[#e5e5e5]">
                {Math.round((1 - lighting.roughness) * 100)}
              </span>
            </div>
            <div className="flex items-center justify-between gap-2">
              <span className="text-[10px] text-[#8a8a8a] w-14">Specular</span>
              <input
                type="range"
                min={0}
                max={150}
                value={Math.round(lighting.specularStrength * 100)}
                onChange={(e) => updateLighting({ specularStrength: Number(e.target.value) / 100 }, true)}
                className="flex-1"
                aria-label="Specular Strength"
              />
              <span className="font-mono text-[10px] w-7 text-right text-[#e5e5e5]">
                {Math.round(lighting.specularStrength * 100)}
              </span>
            </div>
            <div className="flex items-center justify-between gap-2">
              <span className="text-[10px] text-[#8a8a8a] w-14">SSS Glow</span>
              <input
                type="range"
                min={0}
                max={100}
                value={Math.round(subsurfaceVal * 100)}
                onChange={(e) => updateLighting({ subsurface: Number(e.target.value) / 100 }, true)}
                className="flex-1"
                aria-label="Subsurface Terminator Glow"
              />
              <span className="font-mono text-[10px] w-7 text-right text-[#e5e5e5]">
                {Math.round(subsurfaceVal * 100)}
              </span>
            </div>
            <div className="flex items-center justify-between gap-2">
              <span className="text-[10px] text-[#8a8a8a] w-14">Bounce</span>
              <input
                type="range"
                min={0}
                max={120}
                value={Math.round(lighting.bounceIntensity * 100)}
                onChange={(e) => updateLighting({ bounceIntensity: Number(e.target.value) / 100 }, true)}
                className="flex-1"
                aria-label="Bounce Light Intensity"
              />
              <span className="font-mono text-[10px] w-7 text-right text-[#e5e5e5]">
                {Math.round(lighting.bounceIntensity * 100)}
              </span>
            </div>
            <div className="flex items-center justify-between gap-2">
              <span className="text-[10px] text-[#8a8a8a] w-14">Shadow</span>
              <input
                type="range"
                min={0}
                max={100}
                value={Math.round(lighting.shadowDepth * 100)}
                onChange={(e) => updateLighting({ shadowDepth: Number(e.target.value) / 100 }, true)}
                className="flex-1"
                aria-label="Shadow Depth"
              />
              <span className="font-mono text-[10px] w-7 text-right text-[#e5e5e5]">
                {Math.round(lighting.shadowDepth * 100)}
              </span>
            </div>
          </div>
        </div>
      )}

      {/* Central Area: Illuminated 3D Sphere + Perspective 3D Disc Marker */}
      <div className={`${compact ? 'px-2 py-1' : 'px-3 py-1.5'} flex items-center justify-center shrink-0`}>
        <div
          className="relative flex items-center justify-center"
          style={{ width: effectiveSphereSize, height: effectiveSphereSize }}
        >
          <canvas
            ref={canvasRef}
            data-testid="sphere-canvas"
            style={{ width: effectiveSphereSize, height: effectiveSphereSize }}
            onPointerDown={handleSpherePointerDown}
            onPointerMove={handleSpherePointerMove}
            onPointerUp={handleSpherePointerUp}
            onPointerCancel={handleSpherePointerUp}
            onContextMenu={(e) => e.preventDefault()}
            className={`block touch-none ${lightOrbitMode || isOrbitingLight ? 'cursor-grab active:cursor-grabbing' : 'cursor-crosshair'}`}
          />

          <svg
            width={effectiveSphereSize}
            height={effectiveSphereSize}
            viewBox={`0 0 ${effectiveSphereSize} ${effectiveSphereSize}`}
            className="absolute inset-0 pointer-events-none overflow-visible"
            aria-hidden="true"
          >
            <defs>
              <filter id={shadowFilterId} x="-50%" y="-50%" width="200%" height="200%">
                <feGaussianBlur stdDeviation="2.2" />
              </filter>
            </defs>

            {(lightOrbitMode || isOrbitingLight) && (
              <g>
                <line
                  x1={effectiveSphereSize * 0.5}
                  y1={effectiveSphereSize * 0.5}
                  x2={lightReticleX}
                  y2={lightReticleY}
                  stroke="rgba(229, 229, 229, 0.55)"
                  strokeWidth={1.25}
                  strokeDasharray="3 2.5"
                />
                <circle
                  cx={lightReticleX}
                  cy={lightReticleY}
                  r={5}
                  fill="#e5e5e5"
                  stroke="#161616"
                  strokeWidth={1.5}
                />
              </g>
            )}

            <g
              data-testid="sphere-marker"
              transform={`translate(${projectedMarker.baseX.toFixed(2)}, ${projectedMarker.baseY.toFixed(2)}) rotate(${projectedMarker.rotateDeg.toFixed(2)})`}
            >
              <ellipse
                cx={projectedMarker.shadowLocalX}
                cy={projectedMarker.shadowLocalY}
                rx={projectedMarker.rx * 1.07}
                ry={projectedMarker.ry * 1.07}
                fill="rgba(0, 0, 0, 0.36)"
                filter={`url(#${shadowFilterId})`}
              />

              <ellipse
                cx={0}
                cy={0}
                rx={projectedMarker.rx}
                ry={projectedMarker.ry}
                fill={puckSideHex}
              />
              {projectedMarker.extrudeShift > 0.15 && (
                <rect
                  x={-projectedMarker.rx}
                  y={0}
                  width={projectedMarker.rx * 2}
                  height={projectedMarker.extrudeShift}
                  fill={puckSideHex}
                />
              )}

              <ellipse
                cx={0}
                cy={projectedMarker.extrudeShift}
                rx={projectedMarker.rx}
                ry={projectedMarker.ry}
                fill={puckTopHex}
                stroke={puckRimHex}
                strokeOpacity={0.55}
                strokeWidth={1}
              />
            </g>
          </svg>
        </div>
      </div>

      {/* Lighting Color Slots Panel (Shadow | Base | Light | Rim) */}
      <div
        className={`${compact ? 'px-2 pb-1.5' : 'px-2.5 pb-1.5'} grid grid-cols-4 gap-1 shrink-0`}
      >
        {(
          [
            { id: 'shadow', label: 'Shadow', hex: shadowHex, Icon: Moon },
            { id: 'base', label: 'Base', hex: baseHex, Icon: Droplet },
            { id: 'light', label: 'Light', hex: lightHex, Icon: Sun },
            { id: 'rim', label: 'Rim', hex: rimHex, Icon: Sparkles },
          ] as const
        ).map(({ id, label, hex, Icon }) => {
          const isActive = activeSlot === id;
          return (
            <button
              key={id}
              type="button"
              data-testid={`slot-${id}`}
              aria-pressed={isActive}
              onClick={() => commitState({ ...state, activeSlot: id })}
              title={`${label} Color (${hex})`}
              className={`flex items-center justify-center gap-1 px-1 py-1 rounded cursor-pointer transition-colors ${
                isActive ? 'bg-[#2c2c2c] ring-1 ring-white/[0.16]' : 'hover:bg-[#262626]'
              }`}
            >
              <Icon
                className={`${compact ? 'w-3 h-3' : 'w-3.5 h-3.5'} shrink-0 transition-colors ${
                  isActive ? 'text-[#e5e5e5]' : 'text-[#8a8a8a]'
                }`}
              />
              <span
                className={`rounded-full transition-all block shrink-0 ${
                  isActive
                    ? compact
                      ? 'w-3.5 h-3.5 ring-1 ring-[var(--accent)] ring-offset-1 ring-offset-[#2c2c2c]'
                      : 'w-4 h-4 ring-1 ring-[var(--accent)] ring-offset-1 ring-offset-[#2c2c2c]'
                    : 'w-3.5 h-3.5 ring-1 ring-white/20'
                }`}
                style={{ backgroundColor: hex }}
              />
            </button>
          );
        })}
      </div>

      {/* Active Slot Color Editor: Hue + Exact Swatch Picker + Sat & Val */}
      <div
        className={`${compact ? 'mx-2 mb-1.5 p-1.5' : 'mx-2.5 mb-1.5 p-2'} rounded bg-[#161616] border border-white/[0.06] space-y-1.5 shrink-0`}
      >
        <div className="flex items-center gap-1.5">
          <div
            role="slider"
            tabIndex={0}
            aria-label={`${activeSlot} hue`}
            aria-valuemin={0}
            aria-valuemax={359}
            aria-valuenow={activeHue}
            data-testid="sphere-hue-slider"
            onPointerDown={handleHuePointerDown}
            onPointerMove={handleHuePointerMove}
            onPointerUp={handleHuePointerUp}
            onPointerCancel={handleHuePointerUp}
            onKeyDown={handleHueKeyDown}
            className={`relative flex-1 h-6 px-3 flex items-center cursor-pointer touch-none outline-none focus-visible:ring-1 focus-visible:ring-[var(--accent-border)] rounded bg-[#202020] border border-white/[0.06] ${isBwMode ? 'opacity-45' : ''}`}
          >
            <div
              ref={hueTrackRef}
              className="relative w-full h-1.5 rounded-[2px]"
              style={{
                background:
                  'linear-gradient(to right, #ff1e42 0%, #ffea00 17%, #00e640 33%, #00e5ff 50%, #2952ff 67%, #d500f9 83%, #ff1e42 100%)',
              }}
            >
              <div
                data-testid="sphere-hue-thumb"
                style={{ left: `${huePercent}%` }}
                className="absolute top-1/2 -translate-x-1/2 -translate-y-1/2 min-w-[24px] h-[18px] px-1 rounded bg-[#e5e5e5] text-[#161616] shadow-[0_2px_6px_rgba(0,0,0,0.65)] border border-black/25 flex items-center justify-center font-semibold text-[9.5px] font-mono tabular-nums pointer-events-none"
              >
                {activeHue}
              </div>
            </div>
          </div>

          <label
            title={`Pick exact ${activeSlot} color (${activeSlotHex})`}
            className="relative w-6 h-6 rounded border border-white/[0.14] shrink-0 cursor-pointer overflow-hidden"
            style={{ backgroundColor: activeSlotHex }}
          >
            <input
              type="color"
              aria-label={`Pick ${activeSlot} color`}
              data-testid="sphere-slot-color-input"
              value={activeSlotHex}
              onChange={(e) => {
                const hex = e.target.value;
                if (isValidHex(hex)) {
                  updateActiveSlot(hexToHsv(hex), true);
                }
              }}
              className="absolute inset-0 opacity-0 w-full h-full cursor-pointer"
            />
          </label>
        </div>

        <MiniBarSlider
          label={compact ? 'Chm' : 'Chroma'}
          value={activeSlotHsv.s}
          min={0}
          max={1}
          displayValue={`${Math.round(activeSlotHsv.s * 100)}%`}
          gradient={slotSatGradient}
          onChange={(v, commit) => updateActiveSlot({ s: v }, commit)}
          compact={compact}
          testId="sphere-slot-sat-slider"
        />

        <MiniBarSlider
          label={compact ? 'Val' : 'Value'}
          value={activeSlotHsv.v}
          min={0}
          max={1}
          displayValue={`${Math.round(activeSlotHsv.v * 100)}%`}
          gradient={slotValGradient}
          onChange={(v, commit) => updateActiveSlot({ v }, commit)}
          compact={compact}
          testId="sphere-slot-val-slider"
        />
      </div>

      {/* Scene Lighting Presets, Exposure, Ambient Fill, Contrast & Saturation */}
      <div
        className={`${compact ? 'mx-2 mb-1.5 p-1.5' : 'mx-2.5 mb-2 p-2'} rounded bg-[#161616] border border-white/[0.06] space-y-1.5 shrink-0`}
      >
        <div className="flex items-center gap-1.5 pb-0.5">
          <select
            aria-label="Lighting Preset"
            data-testid="sphere-preset-select"
            defaultValue=""
            onChange={(e) => {
              if (e.target.value) {
                applyPreset(e.target.value);
                e.target.value = '';
              }
            }}
            className="flex-1 min-w-0 h-5 px-1.5 rounded bg-[#202020] hover:bg-[#262626] border border-white/[0.08] text-[10px] text-[#cccccc] outline-none cursor-pointer"
          >
            <option value="" disabled>
              Lighting Mood Preset...
            </option>
            {SPHERE_LIGHTING_PRESETS.map((preset) => (
              <option key={preset.id} value={preset.id} className="bg-[#202020] text-[#e5e5e5]">
                {preset.label}
              </option>
            ))}
          </select>
          <button
            type="button"
            onClick={() => {
              const resetState = createInitialSphereState(previousColor, monochromeDefault);
              commitState(resetState);
              emitColor(resetState, true);
            }}
            title="Reset Lighting & Colors"
            aria-label="Reset Lighting"
            className="w-5 h-5 rounded flex items-center justify-center bg-[#202020] hover:bg-[#2c2c2c] border border-white/[0.06] text-[#8a8a8a] hover:text-[#e5e5e5] cursor-pointer shrink-0 transition-colors"
          >
            <RotateCcw className="w-2.5 h-2.5" />
          </button>
        </div>

        <MiniBarSlider
          label="Light"
          value={lighting.lightIntensity}
          min={0.1}
          max={2.8}
          displayValue={`${Math.round(lighting.lightIntensity * 100)}%`}
          gradient={lightGradient}
          onChange={(v, commit) => updateLighting({ lightIntensity: v }, commit)}
          compact={compact}
          testId="sphere-light-slider"
        />

        <MiniBarSlider
          label={compact ? 'Amb' : 'Ambient'}
          value={ambientVal}
          min={0}
          max={1.0}
          displayValue={`${Math.round(ambientVal * 100)}%`}
          gradient={ambientGradient}
          onChange={(v, commit) => updateLighting({ ambientIntensity: v }, commit)}
          compact={compact}
          testId="sphere-ambient-slider"
        />

        <MiniBarSlider
          label={compact ? 'Ctr' : 'Contrast'}
          value={lighting.contrast}
          min={0.4}
          max={2.2}
          displayValue={`${Math.round(lighting.contrast * 100)}%`}
          gradient="linear-gradient(to right, #6e6e6e 0%, #3a3a3a 48%, #101010 72%, #e5e5e5 100%)"
          onChange={(v, commit) => updateLighting({ contrast: v }, commit)}
          compact={compact}
          testId="sphere-contrast-slider"
        />

        <MiniBarSlider
          label="Sat"
          value={lighting.saturation}
          min={0}
          max={1.8}
          displayValue={`${Math.round(lighting.saturation * 100)}%`}
          gradient={satGradient}
          onChange={(v, commit) => updateLighting({ saturation: v }, commit)}
          compact={compact}
          testId="sphere-sat-slider"
          rightAction={
            <button
              type="button"
              onClick={handleToggleBw}
              data-testid="sphere-bw-toggle"
              title={isBwMode ? 'Restore Color Saturation' : 'Black & White / Grayscale Mode (0% Sat)'}
              className={`px-1.5 py-0.5 rounded-xs text-[9px] font-mono font-semibold cursor-pointer transition-colors shrink-0 ${
                isBwMode
                  ? 'bg-[var(--accent)] text-[var(--accent-contrast)]'
                  : 'bg-[#262626] text-[#8a8a8a] hover:text-[#e5e5e5] hover:bg-[#2c2c2c]'
              }`}
            >
              B&amp;W
            </button>
          }
        />
      </div>

      {/* Compact Studio HEX & RGB Output Footer */}
      <div
        className={`${compact ? 'px-2 pb-1.5 gap-1' : 'px-2.5 pb-2 gap-1.5'} flex items-center justify-between text-[10px] font-mono shrink-0`}
      >
        <button
          type="button"
          onClick={() => handleCopy('hex')}
          title="Copy HEX"
          data-testid="sphere-output-hex"
          className="flex items-center gap-1.5 px-2 py-0.5 rounded bg-[#161616] hover:bg-[#2c2c2c] border border-white/[0.06] text-[#e5e5e5] cursor-pointer transition-colors"
        >
          <span>{sampledColor.hex}</span>
          {copiedField === 'hex' ? (
            <Check className="w-2.5 h-2.5 text-emerald-400" />
          ) : (
            <Copy className="w-2.5 h-2.5 text-[#8a8a8a]" />
          )}
        </button>

        <button
          type="button"
          onClick={() => handleCopy('rgb')}
          title="Copy RGB"
          data-testid="sphere-output-rgb"
          className="flex items-center gap-1.5 px-2 py-0.5 rounded bg-[#161616] hover:bg-[#2c2c2c] border border-white/[0.06] text-[#8a8a8a] hover:text-[#e5e5e5] cursor-pointer transition-colors truncate"
        >
          <span className="truncate">
            {sampledColor.rgb.r}, {sampledColor.rgb.g}, {sampledColor.rgb.b}
          </span>
          {copiedField === 'rgb' ? (
            <Check className="w-2.5 h-2.5 text-emerald-400 shrink-0" />
          ) : (
            <Copy className="w-2.5 h-2.5 text-[#8a8a8a] shrink-0" />
          )}
        </button>
      </div>
    </div>
  );
};

export interface SphereColorPickerModalProps extends SphereColorPickerProps {
  isOpen: boolean;
  onClose: () => void;
  /** When false (default), renders as a non-blocking draggable floating studio palette. */
  blocking?: boolean;
}

const FLOAT_POS_STORAGE_KEY = 'ink_sphere_float_pos';
const FLOAT_WIDTH_STORAGE_KEY = 'ink_sphere_float_width';

function loadSavedFloatPos(panelWidth: number): { x: number; y: number } {
  const vw = typeof window !== 'undefined' ? window.innerWidth : 1280;
  const vh = typeof window !== 'undefined' ? window.innerHeight : 800;
  try {
    const raw = localStorage.getItem(FLOAT_POS_STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (typeof parsed?.x === 'number' && typeof parsed?.y === 'number') {
        return {
          x: Math.max(8, Math.min(vw - panelWidth - 8, parsed.x)),
          y: Math.max(8, Math.min(vh - 120, parsed.y)),
        };
      }
    }
  } catch {
    // ignore storage errors
  }
  return {
    x: Math.max(16, vw - panelWidth - 260),
    y: Math.max(48, Math.round(vh * 0.14)),
  };
}

function loadSavedFloatWidth(): number {
  try {
    const raw = localStorage.getItem(FLOAT_WIDTH_STORAGE_KEY);
    const n = raw ? parseInt(raw, 10) : NaN;
    if (!isNaN(n)) return Math.max(240, Math.min(360, n));
  } catch {
    // ignore
  }
  return 276;
}

/**
 * Unpinned, freely draggable, resizable, non-blocking floating 3D Sphere Color Picker.
 */
export const SphereColorPickerModal: React.FC<SphereColorPickerModalProps> = ({
  isOpen,
  onClose,
  blocking = false,
  ...pickerProps
}) => {
  const [panelWidth, setPanelWidth] = useState<number>(() => loadSavedFloatWidth());
  const [pos, setPos] = useState<{ x: number; y: number }>(() => loadSavedFloatPos(panelWidth));
  const dragOriginRef = useRef<{ startX: number; startY: number; origX: number; origY: number } | null>(
    null
  );
  const resizeOriginRef = useRef<{ startX: number; origWidth: number } | null>(null);

  useEffect(() => {
    if (!isOpen) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [isOpen, onClose]);

  useEffect(() => {
    if (!isOpen || blocking) return;
    const onResize = () => {
      setPos((prev) => ({
        x: Math.max(8, Math.min(window.innerWidth - panelWidth - 8, prev.x)),
        y: Math.max(8, Math.min(window.innerHeight - 100, prev.y)),
      }));
    };
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, [isOpen, blocking, panelWidth]);

  const handleHeaderDragStart = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (blocking || e.button !== 0) return;
      e.preventDefault();
      e.stopPropagation();
      dragOriginRef.current = {
        startX: e.clientX,
        startY: e.clientY,
        origX: pos.x,
        origY: pos.y,
      };

      const onMove = (ev: PointerEvent) => {
        const origin = dragOriginRef.current;
        if (!origin) return;
        const nextX = Math.max(
          8,
          Math.min(window.innerWidth - panelWidth - 8, origin.origX + (ev.clientX - origin.startX))
        );
        const nextY = Math.max(
          8,
          Math.min(window.innerHeight - 80, origin.origY + (ev.clientY - origin.startY))
        );
        setPos({ x: Math.round(nextX), y: Math.round(nextY) });
      };

      const onUp = (ev: PointerEvent) => {
        const origin = dragOriginRef.current;
        if (origin) {
          const finalX = Math.max(
            8,
            Math.min(window.innerWidth - panelWidth - 8, origin.origX + (ev.clientX - origin.startX))
          );
          const finalY = Math.max(
            8,
            Math.min(window.innerHeight - 80, origin.origY + (ev.clientY - origin.startY))
          );
          safeLocalStorageSetItem(
            FLOAT_POS_STORAGE_KEY,
            JSON.stringify({ x: Math.round(finalX), y: Math.round(finalY) }),
            'sphere floating position'
          );
        }
        dragOriginRef.current = null;
        window.removeEventListener('pointermove', onMove);
        window.removeEventListener('pointerup', onUp);
      };

      window.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', onUp);
    },
    [blocking, pos.x, pos.y, panelWidth]
  );

  const handleResizeStart = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      e.preventDefault();
      e.stopPropagation();
      resizeOriginRef.current = { startX: e.clientX, origWidth: panelWidth };

      const onMove = (ev: PointerEvent) => {
        const origin = resizeOriginRef.current;
        if (!origin) return;
        const nextW = Math.max(240, Math.min(360, Math.round(origin.origWidth + (ev.clientX - origin.startX))));
        setPanelWidth(nextW);
      };

      const onUp = (ev: PointerEvent) => {
        const origin = resizeOriginRef.current;
        if (origin) {
          const finalW = Math.max(240, Math.min(360, Math.round(origin.origWidth + (ev.clientX - origin.startX))));
          safeLocalStorageSetItem(FLOAT_WIDTH_STORAGE_KEY, String(finalW), 'sphere floating width');
        }
        resizeOriginRef.current = null;
        window.removeEventListener('pointermove', onMove);
        window.removeEventListener('pointerup', onUp);
      };

      window.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', onUp);
    },
    [panelWidth]
  );

  if (!isOpen) return null;

  const computedSphereSize = Math.max(176, panelWidth - 48);

  const content = blocking ? (
    <div
      className="fixed inset-0 z-[120] flex items-center justify-center bg-black/50 backdrop-blur-[2px]"
      onPointerDown={onClose}
      role="dialog"
      aria-modal="true"
      aria-label="3D Sphere Color Picker"
    >
      <SphereColorPicker
        {...pickerProps}
        variant="floating"
        sphereSize={computedSphereSize}
        onClose={onClose}
        className="w-[276px]"
      />
    </div>
  ) : (
    <div
      style={{ left: pos.x, top: pos.y, width: panelWidth }}
      role="dialog"
      aria-modal="false"
      aria-label="3D Sphere Color Picker"
      className="fixed z-[95] pointer-events-auto"
    >
      <div className="relative">
        <SphereColorPicker
          {...pickerProps}
          variant="floating"
          isPinned={false}
          sphereSize={computedSphereSize}
          onClose={onClose}
          onHeaderDragStart={handleHeaderDragStart}
          className="w-full"
        />
        <div
          onPointerDown={handleResizeStart}
          title="Drag to resize"
          className="absolute bottom-0.5 right-0.5 w-3 h-3 cursor-nwse-resize opacity-35 hover:opacity-80 transition-opacity"
          style={{
            background:
              'linear-gradient(135deg, transparent 45%, #8a8a8a 45%, #8a8a8a 58%, transparent 58%, transparent 72%, #8a8a8a 72%, #8a8a8a 85%, transparent 85%)',
          }}
        />
      </div>
    </div>
  );

  return typeof document !== 'undefined' ? createPortal(content, document.body) : content;
};
