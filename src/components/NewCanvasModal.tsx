import React, { useState, useId, useMemo, useEffect, useCallback, useRef } from 'react';
import {
  X,
  Lock,
  Unlock,
  FilePlus,
  Paintbrush,
  BookOpen,
  Smartphone,
  Check,
  AlertTriangle,
} from 'lucide-react';
import { CanvasColorMode, NewCanvasOptions } from '../types/editor';

export type ProjectCategory = 'illustration' | 'manga' | 'webtoon' | 'custom';
type PresetTabCategory = Exclude<ProjectCategory, 'custom'>;
type DimensionUnit = 'px' | 'cm' | 'mm' | 'in';

export interface PresetCanvas {
  id: string;
  name: string;
  category: ProjectCategory;
  groupLabel: string;
  width: number;
  height: number;
  ratioLabel: string;
  ratioX: number;
  ratioY: number;
  defaultMode: CanvasColorMode;
  defaultDpi: number;
  defaultFrequency?: number;
  description?: string;
}

export const CANVAS_PRESETS: PresetCanvas[] = [
  // Illustration & Print
  {
    id: 'fhd',
    name: 'Full HD (1080p)',
    category: 'illustration',
    groupLabel: 'Illustration & Screen',
    width: 1920,
    height: 1080,
    ratioLabel: '16:9',
    ratioX: 16,
    ratioY: 9,
    defaultMode: 'color',
    defaultDpi: 72,
    description: '1920 × 1080 standard landscape screen format',
  },
  {
    id: '4k',
    name: '4K Ultra HD',
    category: 'illustration',
    groupLabel: 'Illustration & Screen',
    width: 3840,
    height: 2160,
    ratioLabel: '16:9',
    ratioX: 16,
    ratioY: 9,
    defaultMode: 'color',
    defaultDpi: 150,
    description: '3840 × 2160 high-resolution digital art canvas',
  },
  {
    id: 'a4-300',
    name: 'A4 Print (300 DPI)',
    category: 'illustration',
    groupLabel: 'Commercial Manga & Print',
    width: 2480,
    height: 3508,
    ratioLabel: 'A4',
    ratioX: 2480,
    ratioY: 3508,
    defaultMode: 'color',
    defaultDpi: 300,
    description: 'Standard international A4 print format (300 DPI)',
  },
  {
    id: 'square',
    name: 'Square (1:1)',
    category: 'illustration',
    groupLabel: 'Illustration & Screen',
    width: 1080,
    height: 1080,
    ratioLabel: '1:1',
    ratioX: 1,
    ratioY: 1,
    defaultMode: 'color',
    defaultDpi: 72,
    description: '1:1 square canvas for avatars and social feeds',
  },
  {
    id: 'photo-3-2',
    name: 'Classic Photo (3:2)',
    category: 'illustration',
    groupLabel: 'Illustration & Screen',
    width: 1800,
    height: 1200,
    ratioLabel: '3:2',
    ratioX: 3,
    ratioY: 2,
    defaultMode: 'color',
    defaultDpi: 300,
    description: '3:2 35mm photography landscape ratio',
  },
  {
    id: 'cinema',
    name: 'Ultrawide (21:9)',
    category: 'illustration',
    groupLabel: 'Illustration & Screen',
    width: 2560,
    height: 1080,
    ratioLabel: '21:9',
    ratioX: 21,
    ratioY: 9,
    defaultMode: 'color',
    defaultDpi: 72,
    description: '21:9 ultrawide panoramic canvas',
  },

  // Manga & Print
  {
    id: 'shueisha-manga-a',
    name: 'Shueisha A (Shonen Jump)',
    category: 'manga',
    groupLabel: '--Shueisha--',
    width: 6071,
    height: 8598,
    ratioLabel: 'B5',
    ratioX: 6071,
    ratioY: 8598,
    defaultMode: 'monochrome',
    defaultDpi: 600,
    defaultFrequency: 60,
    description: 'Weekly Shonen Jump manuscript standard (600 DPI monochrome, 60 LPI)',
  },
  {
    id: 'shueisha-manga-b',
    name: 'Shueisha B (Young Jump)',
    category: 'manga',
    groupLabel: '--Shueisha--',
    width: 6071,
    height: 8598,
    ratioLabel: 'B5',
    ratioX: 6071,
    ratioY: 8598,
    defaultMode: 'monochrome',
    defaultDpi: 600,
    defaultFrequency: 60,
    description: 'Young Jump manuscript standard (600 DPI monochrome, 60 LPI)',
  },
  {
    id: 'manga-b5-600',
    name: 'Manga B5 Commercial',
    category: 'manga',
    groupLabel: 'Commercial Manga & Print',
    width: 4299,
    height: 6071,
    ratioLabel: 'B5',
    ratioX: 4299,
    ratioY: 6071,
    defaultMode: 'monochrome',
    defaultDpi: 600,
    defaultFrequency: 60,
    description: 'Standard commercial manga publishing (600 DPI)',
  },
  {
    id: 'manga-b5-300',
    name: 'Manga B5 Draft',
    category: 'manga',
    groupLabel: 'Commercial Manga & Print',
    width: 2150,
    height: 3035,
    ratioLabel: 'B5',
    ratioX: 2150,
    ratioY: 3035,
    defaultMode: 'monochrome',
    defaultDpi: 300,
    defaultFrequency: 60,
    description: 'Draft or web manga format at 300 DPI',
  },

  // Webtoon & Mobile
  {
    id: 'webtoon',
    name: 'Webtoon Episode',
    category: 'webtoon',
    groupLabel: 'Webtoon & Mobile',
    width: 800,
    height: 1280,
    ratioLabel: '5:8',
    ratioX: 5,
    ratioY: 8,
    defaultMode: 'color',
    defaultDpi: 150,
    description: 'Standard 800px width vertical webtoon canvas strip',
  },
  {
    id: 'story',
    name: 'Mobile Story (9:16)',
    category: 'webtoon',
    groupLabel: 'Webtoon & Mobile',
    width: 1080,
    height: 1920,
    ratioLabel: '9:16',
    ratioX: 9,
    ratioY: 16,
    defaultMode: 'color',
    defaultDpi: 72,
    description: 'Vertical mobile screen format',
  },

  // Custom
  {
    id: 'custom',
    name: 'Custom Size',
    category: 'custom',
    groupLabel: 'Custom',
    width: 1920,
    height: 1080,
    ratioLabel: '16:9',
    ratioX: 16,
    ratioY: 9,
    defaultMode: 'color',
    defaultDpi: 300,
    description: 'Freely configured canvas dimensions',
  },
];

export const DPI_PRESETS = [
  { dpi: 72, label: '72', desc: 'Screen' },
  { dpi: 150, label: '150', desc: 'Draft' },
  { dpi: 300, label: '300', desc: 'Print' },
  { dpi: 350, label: '350', desc: 'Color' },
  { dpi: 600, label: '600', desc: 'Manga' },
  { dpi: 1200, label: '1200', desc: 'Hi-Res' },
];

const QUICK_DPI_VALUES = [72, 150, 300, 600] as const;

export const COMMON_FREQUENCIES = [28, 42.5, 50, 60, 70, 85];

const UNITS: DimensionUnit[] = ['px', 'cm', 'mm', 'in'];

const BG_SWATCHES: Array<{ id: string; label: string; value: string; color?: string }> = [
  { id: 'transparent', label: 'None', value: 'transparent' },
  { id: 'white', label: 'White', value: '#ffffff', color: '#ffffff' },
  { id: 'warm', label: 'Warm', value: '#fcf8f2', color: '#fcf8f2' },
  { id: 'slate', label: 'Dark', value: '#1e1e1e', color: '#1e1e1e' },
  { id: 'black', label: 'Black', value: '#000000', color: '#000000' },
];

const CATEGORY_TABS: Array<{ id: PresetTabCategory; label: string; icon: React.ReactNode }> = [
  { id: 'illustration', label: 'Illustration', icon: <Paintbrush className="w-3 h-3" /> },
  { id: 'manga', label: 'Manga', icon: <BookOpen className="w-3 h-3" /> },
  { id: 'webtoon', label: 'Webtoon', icon: <Smartphone className="w-3 h-3" /> },
];

const MIN_PX = 1;
const MAX_PX = 16384;
const MIN_DPI = 1;
const MAX_DPI = 4800;
const LARGE_CANVAS_MP = 64;

function clampPx(val: number): number {
  if (!Number.isFinite(val)) return MIN_PX;
  return Math.max(MIN_PX, Math.min(MAX_PX, Math.round(val)));
}

function clampDpi(val: number): number {
  if (!Number.isFinite(val)) return 300;
  return Math.max(MIN_DPI, Math.min(MAX_DPI, Math.round(val)));
}

function clampFrequency(val: number): number {
  if (!Number.isFinite(val)) return 60;
  return Math.max(20, Math.min(85, val));
}

function gcd(a: number, b: number): number {
  let x = Math.round(Math.abs(a));
  let y = Math.round(Math.abs(b));
  while (y !== 0) {
    const t = y;
    y = x % y;
    x = t;
  }
  return x || 1;
}

function pxToUnit(px: number, unit: DimensionUnit, dpi: number): number {
  const safeDpi = Math.max(1, dpi);
  switch (unit) {
    case 'px':
      return Math.round(px);
    case 'in':
      return px / safeDpi;
    case 'cm':
      return (px / safeDpi) * 2.54;
    case 'mm':
      return (px / safeDpi) * 25.4;
  }
}

function unitToPx(value: number, unit: DimensionUnit, dpi: number): number {
  const safeDpi = Math.max(1, dpi);
  switch (unit) {
    case 'px':
      return clampPx(value);
    case 'in':
      return clampPx(value * safeDpi);
    case 'cm':
      return clampPx((value / 2.54) * safeDpi);
    case 'mm':
      return clampPx((value / 25.4) * safeDpi);
  }
}

function formatUnitValue(px: number, unit: DimensionUnit, dpi: number): string {
  const val = pxToUnit(px, unit, dpi);
  if (unit === 'px') return String(Math.round(val));
  const decimals = unit === 'mm' ? 1 : 2;
  return String(Number(val.toFixed(decimals)));
}

function normalizeHex(raw: string): string | null {
  const trimmed = raw.trim();
  const shortMatch = /^#([0-9a-fA-F]{3})$/.exec(trimmed);
  if (shortMatch) {
    const [r, g, b] = shortMatch[1].split('');
    return `#${r}${r}${g}${g}${b}${b}`.toLowerCase();
  }
  if (/^#[0-9a-fA-F]{6}$/.test(trimmed)) {
    return trimmed.toLowerCase();
  }
  return null;
}

function isDarkHex(hex: string): boolean {
  const norm = normalizeHex(hex);
  if (!norm) return false;
  const r = parseInt(norm.slice(1, 3), 16);
  const g = parseInt(norm.slice(3, 5), 16);
  const b = parseInt(norm.slice(5, 7), 16);
  return 0.299 * r + 0.587 * g + 0.114 * b < 110;
}

function findMatchingPreset(w: number, h: number): PresetCanvas | undefined {
  return CANVAS_PRESETS.find(
    (p) => p.category !== 'custom' && p.width === w && p.height === h
  );
}

interface NewCanvasModalProps {
  isOpen: boolean;
  onClose: () => void;
  onCreate: (options: NewCanvasOptions) => void;
  initialWidth?: number;
  initialHeight?: number;
  initialDpi?: number;
  initialColorMode?: CanvasColorMode;
  initialName?: string;
}

export const NewCanvasModal: React.FC<NewCanvasModalProps> = ({
  isOpen,
  onClose,
  onCreate,
  initialWidth = 1920,
  initialHeight = 1080,
  initialDpi = 300,
  initialColorMode = 'color',
  initialName = 'Untitled*',
}) => {
  const titleId = useId();
  const nameInputId = useId();
  const widthInputId = useId();
  const heightInputId = useId();
  const dpiInputId = useId();
  const freqInputId = useId();

  const [activeTab, setActiveTab] = useState<PresetTabCategory>('illustration');
  const [selectedPresetId, setSelectedPresetId] = useState<string>('custom');
  const [documentName, setDocumentName] = useState<string>('Untitled');
  const [unit, setUnit] = useState<DimensionUnit>('px');

  const [width, setWidth] = useState<number>(() => clampPx(initialWidth));
  const [height, setHeight] = useState<number>(() => clampPx(initialHeight));
  const [dpi, setDpi] = useState<number>(() => clampDpi(initialDpi));

  // String-backed drafts prevent aggressive clamping mid-keystroke
  const [widthDraft, setWidthDraft] = useState<string>(() => String(clampPx(initialWidth)));
  const [heightDraft, setHeightDraft] = useState<string>(() => String(clampPx(initialHeight)));
  const [dpiDraft, setDpiDraft] = useState<string>(() => String(clampDpi(initialDpi)));

  const [lockRatio, setLockRatio] = useState<boolean>(false);
  const [ratioX, setRatioX] = useState<number>(() => clampPx(initialWidth));
  const [ratioY, setRatioY] = useState<number>(() => clampPx(initialHeight));

  const [colorMode, setColorMode] = useState<CanvasColorMode>(initialColorMode);
  const [defaultFrequency, setDefaultFrequency] = useState<number>(60);
  const [backgroundColor, setBackgroundColor] = useState<string>('#ffffff');
  const [customHex, setCustomHex] = useState<string>('#ffffff');

  const wasOpenRef = useRef(false);

  // Sync state strictly on open transition
  useEffect(() => {
    if (isOpen && !wasOpenRef.current) {
      const safeW = clampPx(initialWidth);
      const safeH = clampPx(initialHeight);
      const safeDpi = clampDpi(initialDpi);
      const matched = findMatchingPreset(safeW, safeH);

      setDocumentName((initialName || 'Untitled').replace(/\*+$/, '').trim() || 'Untitled');
      setWidth(safeW);
      setHeight(safeH);
      setDpi(safeDpi);
      setUnit('px');
      setWidthDraft(String(safeW));
      setHeightDraft(String(safeH));
      setDpiDraft(String(safeDpi));
      setRatioX(matched ? matched.ratioX : safeW);
      setRatioY(matched ? matched.ratioY : safeH);
      setColorMode(initialColorMode);
      setSelectedPresetId(matched ? matched.id : 'custom');
      if (matched && matched.category !== 'custom') {
        setActiveTab(matched.category);
      }
    }
    wasOpenRef.current = isOpen;
  }, [isOpen, initialWidth, initialHeight, initialDpi, initialColorMode, initialName]);

  const syncDimensionDrafts = useCallback(
    (nextW: number, nextH: number, nextUnit: DimensionUnit, nextDpi: number) => {
      setWidthDraft(formatUnitValue(nextW, nextUnit, nextDpi));
      setHeightDraft(formatUnitValue(nextH, nextUnit, nextDpi));
    },
    []
  );

  const visiblePresets = useMemo(
    () => CANVAS_PRESETS.filter((p) => p.category === activeTab),
    [activeTab]
  );

  const simplifiedRatio = useMemo(() => {
    if (width <= 0 || height <= 0) return '1:1';
    const d = gcd(width, height);
    const sx = width / d;
    const sy = height / d;
    if (sx <= 32 && sy <= 32) return `${sx}:${sy}`;
    return `${(width / height).toFixed(2)}:1`;
  }, [width, height]);

  const printCm = useMemo(() => {
    const safeDpi = Math.max(1, dpi);
    return {
      w: ((width / safeDpi) * 2.54).toFixed(1),
      h: ((height / safeDpi) * 2.54).toFixed(1),
    };
  }, [width, height, dpi]);

  const megapixelsNum = useMemo(() => (width * height) / 1_000_000, [width, height]);
  const megapixels = useMemo(() => megapixelsNum.toFixed(1), [megapixelsNum]);

  const applyPreset = useCallback(
    (preset: PresetCanvas) => {
      setSelectedPresetId(preset.id);
      setWidth(preset.width);
      setHeight(preset.height);
      setDpi(preset.defaultDpi);
      setRatioX(preset.ratioX);
      setRatioY(preset.ratioY);
      setColorMode(preset.defaultMode);
      if (preset.defaultFrequency) {
        setDefaultFrequency(preset.defaultFrequency);
      }
      setDpiDraft(String(preset.defaultDpi));
      syncDimensionDrafts(preset.width, preset.height, unit, preset.defaultDpi);
    },
    [syncDimensionDrafts, unit]
  );

  const handleUnitChange = (nextUnit: DimensionUnit) => {
    setUnit(nextUnit);
    syncDimensionDrafts(width, height, nextUnit, dpi);
  };

  const handleWidthInputChange = (raw: string) => {
    setWidthDraft(raw);
    const parsed = Number(raw);
    if (!raw.trim() || !Number.isFinite(parsed) || parsed <= 0) return;

    const nextW = unitToPx(parsed, unit, dpi);
    let nextH = height;
    if (lockRatio && ratioX > 0 && ratioY > 0) {
      nextH = clampPx((nextW * ratioY) / ratioX);
      setHeight(nextH);
      setHeightDraft(formatUnitValue(nextH, unit, dpi));
    } else {
      setRatioX(nextW);
      setRatioY(nextH);
    }
    setWidth(nextW);
    const matched = findMatchingPreset(nextW, nextH);
    setSelectedPresetId(matched ? matched.id : 'custom');
  };

  const handleHeightInputChange = (raw: string) => {
    setHeightDraft(raw);
    const parsed = Number(raw);
    if (!raw.trim() || !Number.isFinite(parsed) || parsed <= 0) return;

    const nextH = unitToPx(parsed, unit, dpi);
    let nextW = width;
    if (lockRatio && ratioX > 0 && ratioY > 0) {
      nextW = clampPx((nextH * ratioX) / ratioY);
      setWidth(nextW);
      setWidthDraft(formatUnitValue(nextW, unit, dpi));
    } else {
      setRatioX(nextW);
      setRatioY(nextH);
    }
    setHeight(nextH);
    const matched = findMatchingPreset(nextW, nextH);
    setSelectedPresetId(matched ? matched.id : 'custom');
  };

  const handleDimensionBlur = () => {
    syncDimensionDrafts(width, height, unit, dpi);
  };

  const handleToggleLockRatio = () => {
    setLockRatio((prev) => {
      if (!prev) {
        setRatioX(width);
        setRatioY(height);
      }
      return !prev;
    });
  };

  const handleSetOrientation = (target: 'portrait' | 'landscape') => {
    if (width === height) return;
    const isCurrentlyLandscape = width > height;
    if ((target === 'landscape' && isCurrentlyLandscape) || (target === 'portrait' && !isCurrentlyLandscape)) {
      return;
    }
    const nextW = height;
    const nextH = width;
    setWidth(nextW);
    setHeight(nextH);
    setRatioX(ratioY);
    setRatioY(ratioX);
    syncDimensionDrafts(nextW, nextH, unit, dpi);
    const matched = findMatchingPreset(nextW, nextH);
    setSelectedPresetId(matched ? matched.id : 'custom');
  };

  const applyDpiChange = useCallback(
    (nextDpiRaw: number) => {
      const nextDpi = clampDpi(nextDpiRaw);
      if (unit !== 'px') {
        // Preserve physical print size when editing in cm/mm/in
        const physW = pxToUnit(width, unit, dpi);
        const physH = pxToUnit(height, unit, dpi);
        const nextW = unitToPx(physW, unit, nextDpi);
        const nextH = unitToPx(physH, unit, nextDpi);
        setWidth(nextW);
        setHeight(nextH);
        setRatioX(nextW);
        setRatioY(nextH);
        syncDimensionDrafts(nextW, nextH, unit, nextDpi);
        const matched = findMatchingPreset(nextW, nextH);
        setSelectedPresetId(matched ? matched.id : 'custom');
      }
      setDpi(nextDpi);
      setDpiDraft(String(nextDpi));
    },
    [dpi, height, syncDimensionDrafts, unit, width]
  );

  const handleDpiInputChange = (raw: string) => {
    setDpiDraft(raw);
    const parsed = Number(raw);
    if (!raw.trim() || !Number.isFinite(parsed) || parsed < 1) return;
    applyDpiChange(parsed);
  };

  const handleDpiBlur = () => {
    setDpiDraft(String(dpi));
  };

  const handleSelectColorMode = (mode: CanvasColorMode) => {
    setColorMode(mode);
    if (mode === 'monochrome' && dpi < 600) {
      applyDpiChange(600);
    }
  };

  const handleCreate = useCallback(() => {
    const safeW = clampPx(width);
    const safeH = clampPx(height);
    const safeDpi = clampDpi(dpi);
    const safeFreq = clampFrequency(defaultFrequency);
    let finalName = documentName.trim() || 'Untitled';
    if (!/\.[a-zA-Z0-9]+$/.test(finalName) && !finalName.endsWith('*')) {
      finalName = `${finalName}*`;
    }

    onCreate({
      name: finalName,
      width: safeW,
      height: safeH,
      dpi: safeDpi,
      aspectRatioPreset: selectedPresetId,
      aspectRatioX: ratioX,
      aspectRatioY: ratioY,
      lockAspectRatio: lockRatio,
      backgroundColor,
      colorMode,
      defaultFrequency: safeFreq,
    });
    onClose();
  }, [
    backgroundColor,
    colorMode,
    defaultFrequency,
    documentName,
    dpi,
    height,
    lockRatio,
    onClose,
    onCreate,
    ratioX,
    ratioY,
    selectedPresetId,
    width,
  ]);

  // Global Escape / Enter shortcuts while open
  useEffect(() => {
    if (!isOpen) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
        return;
      }
      if (e.key === 'Enter') {
        const target = e.target as HTMLElement | null;
        if (target instanceof HTMLButtonElement && !e.ctrlKey && !e.metaKey) {
          return;
        }
        e.preventDefault();
        handleCreate();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [isOpen, onClose, handleCreate]);

  if (!isOpen) return null;

  const isTransparent = backgroundColor === 'transparent';
  const isCustomBg =
    !isTransparent &&
    !BG_SWATCHES.some((s) => s.value.toLowerCase() === backgroundColor.toLowerCase());
  const isLargeCanvas = megapixelsNum > LARGE_CANVAS_MP;
  const isLandscape = width > height;
  const isPortrait = height > width;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 p-4 select-none"
      onClick={onClose}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="bg-[#202020] rounded-lg shadow-[0_24px_64px_rgba(0,0,0,0.8)] border border-[#2c2c2c] w-full max-w-[780px] max-h-[88vh] flex flex-col overflow-hidden text-xs text-[#e5e5e5]"
      >
        {/* Header */}
        <div className="h-10 px-4 flex items-center justify-between bg-[#161616] border-b border-[#2c2c2c] shrink-0">
          <div className="flex items-center gap-2">
            <FilePlus className="w-3.5 h-3.5 text-[var(--accent)]" />
            <h2 id={titleId} className="text-xs font-medium text-[#e5e5e5]">
              New Canvas
            </h2>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="w-6 h-6 rounded flex items-center justify-center text-[#8a8a8a] hover:text-[#e5e5e5] hover:bg-[#2c2c2c] transition-colors cursor-pointer"
            title="Close (Esc)"
            aria-label="Close new canvas dialog"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        </div>

        {/* Body: 2-Pane Split */}
        <div className="flex flex-col md:flex-row flex-1 min-h-0 overflow-hidden gap-px bg-[#161616]">
          {/* Left Pane: Presets & Live Ratio Preview */}
          <div className="md:w-[272px] bg-[#202020] flex flex-col shrink-0 min-h-0">
            {/* Category Tabs */}
            <div className="p-2 pb-1.5 shrink-0">
              <div className="grid grid-cols-3 gap-0.5 bg-[#161616] p-0.5 rounded">
                {CATEGORY_TABS.map((tab) => {
                  const active = activeTab === tab.id;
                  return (
                    <button
                      key={tab.id}
                      type="button"
                      onClick={() => setActiveTab(tab.id)}
                      className={`flex items-center justify-center gap-1 py-1.5 px-1.5 rounded text-[11px] transition-colors cursor-pointer ${
                        active
                          ? 'bg-[#2c2c2c] text-[#e5e5e5] font-medium'
                          : 'text-[#8a8a8a] hover:text-[#e5e5e5]'
                      }`}
                    >
                      <span className={active ? 'text-[var(--accent)]' : ''}>{tab.icon}</span>
                      <span className="truncate">{tab.label}</span>
                    </button>
                  );
                })}
              </div>
            </div>

            {/* Preset List */}
            <div className="flex-1 overflow-y-auto px-2 py-1 space-y-1 max-h-[180px] md:max-h-none">
              {visiblePresets.map((preset) => {
                const selected = selectedPresetId === preset.id;
                return (
                  <button
                    key={preset.id}
                    type="button"
                    onClick={() => applyPreset(preset)}
                    className={`w-full text-left px-2.5 py-2 rounded transition-colors cursor-pointer flex items-center justify-between gap-2 ${
                      selected
                        ? 'bg-[#2c2c2c] text-[#e5e5e5]'
                        : 'bg-[#161616]/70 text-[#b5b5b5] hover:bg-[#2c2c2c]/60 hover:text-[#e5e5e5]'
                    }`}
                  >
                    <div className="min-w-0">
                      <div className="flex items-center gap-1.5">
                        <span className="text-xs font-medium truncate">{preset.name}</span>
                        {preset.defaultMode === 'monochrome' && (
                          <span className="text-[9px] font-mono px-1 py-0.25 rounded bg-[#161616] text-[#8a8a8a] shrink-0">
                            MONO
                          </span>
                        )}
                      </div>
                      <div className="text-[10px] font-mono text-[#8a8a8a] mt-0.5">
                        {preset.width} × {preset.height} · {preset.defaultDpi} DPI
                      </div>
                    </div>
                    {selected && <Check className="w-3.5 h-3.5 text-[var(--accent)] shrink-0" />}
                  </button>
                );
              })}
            </div>

            {/* Compact Proportional Preview */}
            <div className="p-3 bg-[#1a1a1a] border-t border-[#2c2c2c] shrink-0 space-y-2">
              <div
                className="w-full h-24 rounded flex items-center justify-center p-2.5 overflow-hidden"
                style={{
                  backgroundImage:
                    'conic-gradient(#1f1f1f 90deg, #161616 90deg 180deg, #1f1f1f 180deg 270deg, #161616 270deg)',
                  backgroundSize: '12px 12px',
                }}
              >
                <div
                  className="max-w-full max-h-full transition-all duration-150 rounded-[2px] shadow-md relative border border-black/60 flex items-center justify-center overflow-hidden"
                  style={{
                    aspectRatio: `${Math.max(1, width)} / ${Math.max(1, height)}`,
                    width: width >= height ? '88%' : 'auto',
                    height: height > width ? '94%' : 'auto',
                    backgroundColor: isTransparent ? undefined : backgroundColor,
                    backgroundImage: isTransparent
                      ? 'conic-gradient(#7a7a7a 90deg, #525252 90deg 180deg, #7a7a7a 180deg 270deg, #525252 270deg)'
                      : undefined,
                    backgroundSize: '8px 8px',
                  }}
                >
                  {colorMode === 'monochrome' && (
                    <div className="absolute inset-1.5 border border-dashed border-[#8a8a8a]/50 pointer-events-none" />
                  )}
                  <span
                    className={`text-[9px] font-mono px-1.5 py-0.5 rounded font-medium z-10 ${
                      !isTransparent && isDarkHex(backgroundColor)
                        ? 'bg-white/15 text-[#e5e5e5]'
                        : 'bg-black/60 text-white'
                    }`}
                  >
                    {simplifiedRatio}
                  </span>
                </div>
              </div>

              <div className="flex items-center justify-between text-[10px] font-mono text-[#8a8a8a]">
                <span className="text-[#e5e5e5]">
                  {width} × {height} px
                </span>
                <span>
                  {printCm.w} × {printCm.h} cm · {megapixels} MP
                </span>
              </div>
            </div>
          </div>

          {/* Right Pane: Configuration Form */}
          <div className="flex-1 bg-[#202020] p-4 overflow-y-auto space-y-4 min-h-0">
            {/* Document Name */}
            <section className="space-y-1.5">
              <label htmlFor={nameInputId} className="text-[11px] font-medium text-[#8a8a8a] block">
                Document Name
              </label>
              <input
                id={nameInputId}
                type="text"
                value={documentName}
                onChange={(e) => setDocumentName(e.target.value)}
                placeholder="Untitled"
                className="w-full px-2.5 py-1.5 text-xs placeholder-[#8a8a8a]/50"
              />
            </section>

            {/* Dimensions + Unit + Orientation */}
            <section className="space-y-2">
              <div className="flex items-center justify-between gap-2">
                <span className="text-[11px] font-medium text-[#8a8a8a]">Dimensions</span>
                <div className="inline-flex bg-[#161616] p-0.5 rounded gap-0.5">
                  {UNITS.map((u) => (
                    <button
                      key={u}
                      type="button"
                      onClick={() => handleUnitChange(u)}
                      className={`px-2 py-0.5 rounded text-[10px] font-mono transition-colors cursor-pointer ${
                        unit === u
                          ? 'bg-[#2c2c2c] text-[#e5e5e5] font-medium'
                          : 'text-[#8a8a8a] hover:text-[#e5e5e5]'
                      }`}
                    >
                      {u}
                    </button>
                  ))}
                </div>
              </div>

              <div className="flex items-end gap-1.5">
                <div className="flex-1 space-y-1">
                  <label htmlFor={widthInputId} className="text-[10px] text-[#8a8a8a] block">
                    Width ({unit})
                  </label>
                  <input
                    id={widthInputId}
                    type="number"
                    min={unit === 'px' ? MIN_PX : 0.1}
                    max={unit === 'px' ? MAX_PX : undefined}
                    step={unit === 'px' ? 1 : 0.1}
                    value={widthDraft}
                    onChange={(e) => handleWidthInputChange(e.target.value)}
                    onBlur={handleDimensionBlur}
                    className="w-full px-2.5 py-1.5 font-mono text-xs"
                  />
                </div>

                <button
                  type="button"
                  onClick={handleToggleLockRatio}
                  aria-pressed={lockRatio}
                  title={lockRatio ? 'Aspect ratio locked' : 'Lock aspect ratio'}
                  className={`h-[30px] w-[30px] shrink-0 rounded flex items-center justify-center transition-colors cursor-pointer ${
                    lockRatio
                      ? 'bg-[#2c2c2c] text-[var(--accent)]'
                      : 'bg-[#161616] text-[#8a8a8a] hover:text-[#e5e5e5] hover:bg-[#2c2c2c]/60'
                  }`}
                >
                  {lockRatio ? <Lock className="w-3.5 h-3.5" /> : <Unlock className="w-3.5 h-3.5" />}
                </button>

                <div className="flex-1 space-y-1">
                  <label htmlFor={heightInputId} className="text-[10px] text-[#8a8a8a] block">
                    Height ({unit})
                  </label>
                  <input
                    id={heightInputId}
                    type="number"
                    min={unit === 'px' ? MIN_PX : 0.1}
                    max={unit === 'px' ? MAX_PX : undefined}
                    step={unit === 'px' ? 1 : 0.1}
                    value={heightDraft}
                    onChange={(e) => handleHeightInputChange(e.target.value)}
                    onBlur={handleDimensionBlur}
                    className="w-full px-2.5 py-1.5 font-mono text-xs"
                  />
                </div>

                {/* Orientation Switch */}
                <div className="h-[30px] shrink-0 bg-[#161616] p-0.5 rounded inline-flex items-center gap-0.5">
                  <button
                    type="button"
                    onClick={() => handleSetOrientation('portrait')}
                    disabled={width === height}
                    title="Portrait orientation"
                    aria-label="Portrait orientation"
                    aria-pressed={isPortrait}
                    className={`h-full px-2 rounded flex items-center justify-center transition-colors ${
                      width === height
                        ? 'opacity-35 cursor-default text-[#8a8a8a]'
                        : isPortrait
                        ? 'bg-[#2c2c2c] text-[var(--accent)] cursor-pointer'
                        : 'text-[#8a8a8a] hover:text-[#e5e5e5] cursor-pointer'
                    }`}
                  >
                    <span className="w-2.5 h-3.5 rounded-[1px] border border-current block" />
                  </button>
                  <button
                    type="button"
                    onClick={() => handleSetOrientation('landscape')}
                    disabled={width === height}
                    title="Landscape orientation"
                    aria-label="Landscape orientation"
                    aria-pressed={isLandscape}
                    className={`h-full px-2 rounded flex items-center justify-center transition-colors ${
                      width === height
                        ? 'opacity-35 cursor-default text-[#8a8a8a]'
                        : isLandscape
                        ? 'bg-[#2c2c2c] text-[var(--accent)] cursor-pointer'
                        : 'text-[#8a8a8a] hover:text-[#e5e5e5] cursor-pointer'
                    }`}
                  >
                    <span className="w-3.5 h-2.5 rounded-[1px] border border-current block" />
                  </button>
                </div>
              </div>

              {isLargeCanvas && (
                <div className="flex items-center gap-1.5 text-[11px] text-amber-400 pt-0.5">
                  <AlertTriangle className="w-3 h-3 shrink-0" />
                  <span>Large canvas ({megapixels} MP) — may increase memory usage.</span>
                </div>
              )}
            </section>

            {/* Resolution (DPI) */}
            <section className="space-y-1.5">
              <div className="flex items-center justify-between">
                <label htmlFor={dpiInputId} className="text-[11px] font-medium text-[#8a8a8a]">
                  Resolution (DPI)
                </label>
                <span className="text-[10px] font-mono text-[#8a8a8a]">
                  {dpi <= 96 ? 'Screen' : dpi < 300 ? 'Draft' : dpi < 600 ? 'Print' : 'Manga / Hi-Res'}
                </span>
              </div>

              <div className="flex items-center gap-1.5">
                <div className="grid grid-cols-4 gap-1.5 flex-1">
                  {QUICK_DPI_VALUES.map((val) => {
                    const selected = dpi === val;
                    return (
                      <button
                        key={val}
                        type="button"
                        onClick={() => applyDpiChange(val)}
                        className={`py-1.5 rounded font-mono text-xs transition-colors cursor-pointer ${
                          selected
                            ? 'bg-[#2c2c2c] text-[#e5e5e5] font-medium'
                            : 'bg-[#161616] text-[#8a8a8a] hover:text-[#e5e5e5] hover:bg-[#2c2c2c]/60'
                        }`}
                      >
                        {val}
                      </button>
                    );
                  })}
                </div>
                <div className="relative w-20 shrink-0">
                  <input
                    id={dpiInputId}
                    type="number"
                    min={MIN_DPI}
                    max={MAX_DPI}
                    value={dpiDraft}
                    onChange={(e) => handleDpiInputChange(e.target.value)}
                    onBlur={handleDpiBlur}
                    aria-label="Custom DPI"
                    className="w-full px-2 py-1.5 font-mono text-xs text-center"
                  />
                </div>
              </div>
            </section>

            {/* Color Mode */}
            <section className="space-y-2">
              <span className="text-[11px] font-medium text-[#8a8a8a] block">Color Mode</span>

              <div className="grid grid-cols-3 gap-1.5">
                {(
                  [
                    {
                      id: 'color' as CanvasColorMode,
                      label: 'Color',
                      swatch: 'bg-gradient-to-tr from-rose-500 via-emerald-400 to-sky-500',
                    },
                    {
                      id: 'grayscale' as CanvasColorMode,
                      label: 'Grayscale',
                      swatch: 'bg-gradient-to-r from-[#111] via-[#888] to-[#eee]',
                    },
                    {
                      id: 'monochrome' as CanvasColorMode,
                      label: 'Monochrome',
                      swatch: 'bg-gradient-to-r from-black from-50% to-white to-50%',
                    },
                  ] as const
                ).map((item) => {
                  const selected = colorMode === item.id;
                  return (
                    <button
                      key={item.id}
                      type="button"
                      onClick={() => handleSelectColorMode(item.id)}
                      className={`flex items-center justify-center gap-2 py-1.5 px-2.5 rounded text-xs transition-colors cursor-pointer ${
                        selected
                          ? 'bg-[#2c2c2c] text-[#e5e5e5] font-medium'
                          : 'bg-[#161616] text-[#8a8a8a] hover:text-[#e5e5e5] hover:bg-[#2c2c2c]/60'
                      }`}
                    >
                      <span
                        className={`w-2.5 h-2.5 rounded-full shrink-0 border border-white/15 ${item.swatch}`}
                      />
                      <span>{item.label}</span>
                    </button>
                  );
                })}
              </div>

              {colorMode === 'monochrome' && (
                <div className="bg-[#161616] rounded p-2.5 space-y-2">
                  <div className="flex items-center justify-between">
                    <label htmlFor={freqInputId} className="text-[11px] text-[#8a8a8a]">
                      Screentone Frequency
                    </label>
                    <span className="text-[11px] font-mono text-[#e5e5e5]">
                      {defaultFrequency} LPI
                    </span>
                  </div>

                  <div className="flex items-center gap-2.5">
                    <input
                      type="range"
                      min="20"
                      max="85"
                      step="0.5"
                      value={defaultFrequency}
                      onChange={(e) => setDefaultFrequency(clampFrequency(Number(e.target.value)))}
                      className="flex-1"
                    />
                    <input
                      id={freqInputId}
                      type="number"
                      min="20"
                      max="85"
                      step="0.5"
                      value={defaultFrequency}
                      onChange={(e) =>
                        setDefaultFrequency(clampFrequency(Number(e.target.value) || 60))
                      }
                      className="w-14 px-1.5 py-1 text-center font-mono text-[11px]"
                    />
                  </div>

                  <div className="flex items-center gap-1 flex-wrap">
                    {COMMON_FREQUENCIES.map((f) => {
                      const active = defaultFrequency === f;
                      return (
                        <button
                          key={f}
                          type="button"
                          onClick={() => setDefaultFrequency(f)}
                          className={`px-2 py-0.5 rounded text-[10px] font-mono transition-colors cursor-pointer ${
                            active
                              ? 'bg-[#2c2c2c] text-[#e5e5e5] font-medium'
                              : 'bg-[#202020] text-[#8a8a8a] hover:text-[#e5e5e5]'
                          }`}
                        >
                          {f}L
                        </button>
                      );
                    })}
                  </div>
                </div>
              )}
            </section>

            {/* Paper Background */}
            <section className="space-y-1.5">
              <div className="flex items-center justify-between">
                <span className="text-[11px] font-medium text-[#8a8a8a]">Background</span>
                <span className="text-[10px] font-mono text-[#8a8a8a]">
                  {isTransparent ? 'Transparent' : backgroundColor.toUpperCase()}
                </span>
              </div>

              <div className="flex items-center gap-1.5 flex-wrap">
                {BG_SWATCHES.map((swatch) => {
                  const selected =
                    backgroundColor.toLowerCase() === swatch.value.toLowerCase();
                  return (
                    <button
                      key={swatch.id}
                      type="button"
                      onClick={() => {
                        setBackgroundColor(swatch.value);
                        if (swatch.color) setCustomHex(swatch.color);
                      }}
                      className={`flex items-center gap-1.5 px-2.5 py-1.5 rounded text-[11px] transition-colors cursor-pointer ${
                        selected
                          ? 'bg-[#2c2c2c] text-[#e5e5e5] font-medium'
                          : 'bg-[#161616] text-[#8a8a8a] hover:text-[#e5e5e5] hover:bg-[#2c2c2c]/60'
                      }`}
                    >
                      {swatch.color ? (
                        <span
                          className="w-2.5 h-2.5 rounded-full border border-white/20 shrink-0"
                          style={{ backgroundColor: swatch.color }}
                        />
                      ) : (
                        <span
                          className="w-2.5 h-2.5 rounded-full border border-white/20 shrink-0"
                          style={{
                            backgroundImage:
                              'conic-gradient(#888 90deg, #444 90deg 180deg, #888 180deg 270deg, #444 270deg)',
                            backgroundSize: '6px 6px',
                          }}
                        />
                      )}
                      <span>{swatch.label}</span>
                    </button>
                  );
                })}

                <div
                  className={`flex items-center gap-1.5 rounded px-2 py-1 ml-auto ${
                    isCustomBg ? 'bg-[#2c2c2c]' : 'bg-[#161616]'
                  }`}
                >
                  <input
                    type="color"
                    value={normalizeHex(customHex) ?? '#ffffff'}
                    onChange={(e) => {
                      const hex = e.target.value.toLowerCase();
                      setCustomHex(hex);
                      setBackgroundColor(hex);
                    }}
                    className="w-4 h-4 cursor-pointer bg-transparent border-0 p-0 rounded shrink-0"
                    title="Pick custom background color"
                    aria-label="Custom background color picker"
                  />
                  <input
                    type="text"
                    value={customHex}
                    maxLength={7}
                    onChange={(e) => {
                      const val = e.target.value;
                      setCustomHex(val);
                      const norm = normalizeHex(val);
                      if (norm) setBackgroundColor(norm);
                    }}
                    onBlur={() => {
                      const norm = normalizeHex(customHex);
                      if (!norm && !isTransparent) {
                        setCustomHex(backgroundColor);
                      }
                    }}
                    aria-label="Custom background hex color"
                    className="w-[58px] font-mono text-[11px] px-1 py-0.5"
                  />
                </div>
              </div>
            </section>
          </div>
        </div>

        {/* Footer */}
        <div className="h-12 px-4 flex items-center justify-between bg-[#161616] border-t border-[#2c2c2c] shrink-0">
          <span className="text-[11px] text-[#8a8a8a] hidden sm:inline">
            <kbd className="px-1.5 py-0.5 rounded bg-[#202020] text-[#b5b5b5] font-mono text-[10px]">
              Enter
            </kbd>{' '}
            to create
          </span>

          <div className="flex items-center gap-2 ml-auto">
            <button
              type="button"
              onClick={onClose}
              className="px-3.5 py-1.5 rounded bg-[#2c2c2c] hover:bg-[#383838] text-[#e5e5e5] text-xs font-medium transition-colors cursor-pointer"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={handleCreate}
              className="px-4 py-1.5 rounded text-xs font-medium transition-opacity hover:opacity-90 cursor-pointer flex items-center gap-1.5"
              style={{
                backgroundColor: 'var(--accent)',
                color: 'var(--accent-contrast)',
              }}
            >
              <span>Create Canvas</span>
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};
