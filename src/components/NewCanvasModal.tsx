import React, { useState, useId, useMemo, useEffect } from 'react';
import {
  X,
  Lock,
  Unlock,
  ArrowLeftRight,
  Palette,
  FileCheck,
  Printer,
  Paintbrush,
  BookOpen,
  Smartphone,
  Sliders,
} from 'lucide-react';
import { CanvasColorMode, NewCanvasOptions } from '../types/editor';

export type ProjectCategory = 'illustration' | 'manga' | 'webtoon' | 'custom';

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
  // --Shueisha Presets
  {
    id: 'shueisha-manga-a',
    name: 'Shueisha manga A (Shonen Jump)',
    category: 'manga',
    groupLabel: '--Shueisha--',
    width: 6071,
    height: 8598,
    ratioLabel: 'Shueisha B5 (1:1.42)',
    ratioX: 6071,
    ratioY: 8598,
    defaultMode: 'monochrome',
    defaultDpi: 600,
    defaultFrequency: 60,
    description: 'Weekly Shonen Jump manuscript submission standard (600 DPI monochrome, 60 LPI)',
  },
  {
    id: 'shueisha-manga-b',
    name: 'Shueisha manga B (Young Jump)',
    category: 'manga',
    groupLabel: '--Shueisha--',
    width: 6071,
    height: 8598,
    ratioLabel: 'Shueisha B5 (1:1.42)',
    ratioX: 6071,
    ratioY: 8598,
    defaultMode: 'monochrome',
    defaultDpi: 600,
    defaultFrequency: 60,
    description: 'Young Jump manuscript submission standard (600 DPI monochrome, 60 LPI)',
  },

  // Commercial Manga & Print
  {
    id: 'manga-b5-600',
    name: 'Manga B5 Commercial (600 DPI)',
    category: 'manga',
    groupLabel: 'Commercial Manga & Print',
    width: 4299,
    height: 6071,
    ratioLabel: 'B5 (~1:1.41)',
    ratioX: 1,
    ratioY: 1.412,
    defaultMode: 'monochrome',
    defaultDpi: 600,
    defaultFrequency: 60,
    description: 'Standard tankobon/commercial manga publishing (600 DPI)',
  },
  {
    id: 'manga-b5-300',
    name: 'Manga B5 Standard (300 DPI)',
    category: 'manga',
    groupLabel: 'Commercial Manga & Print',
    width: 2150,
    height: 3035,
    ratioLabel: 'B5 (~1:1.41)',
    ratioX: 1,
    ratioY: 1.412,
    defaultMode: 'monochrome',
    defaultDpi: 300,
    defaultFrequency: 60,
    description: 'Draft or web manga format at 300 DPI',
  },
  {
    id: 'a4-300',
    name: 'A4 Document / Print (300 DPI)',
    category: 'illustration',
    groupLabel: 'Commercial Manga & Print',
    width: 2480,
    height: 3508,
    ratioLabel: 'A4 (1:√2)',
    ratioX: 1,
    ratioY: 1.414,
    defaultMode: 'color',
    defaultDpi: 300,
    description: 'Standard international A4 print format (300 DPI)',
  },

  // Illustration & Screen
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
    id: 'square',
    name: 'Square Post / Icon',
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
    name: 'Cinematic Ultrawide (21:9)',
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

  // Webtoon & Mobile
  {
    id: 'webtoon',
    name: 'Webtoon Vertical Episode',
    category: 'webtoon',
    groupLabel: 'Webtoon & Mobile',
    width: 800,
    height: 1280,
    ratioLabel: '10:16',
    ratioX: 10,
    ratioY: 16,
    defaultMode: 'color',
    defaultDpi: 150,
    description: 'Standard 800px width vertical webtoon canvas strip',
  },
  {
    id: 'story',
    name: 'Mobile Story / Reel (9:16)',
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

export const COMMON_FREQUENCIES = [28, 42.5, 50, 60, 70, 85];

const BG_PRESETS = [
  { label: 'White', value: '#ffffff', color: '#ffffff' },
  { label: 'Warm Paper', value: '#fcf8f2', color: '#fcf8f2' },
  { label: 'Dark Slate', value: '#1e1e1e', color: '#1e1e1e' },
  { label: 'Black', value: '#000000', color: '#000000' },
];

function gcd(a: number, b: number): number {
  a = Math.round(Math.abs(a));
  b = Math.round(Math.abs(b));
  return b ? gcd(b, a % b) : a;
}

interface NewCanvasModalProps {
  isOpen: boolean;
  onClose: () => void;
  onCreate: (options: NewCanvasOptions) => void;
  initialWidth?: number;
  initialHeight?: number;
  initialDpi?: number;
  initialName?: string;
}

export const NewCanvasModal: React.FC<NewCanvasModalProps> = ({
  isOpen,
  onClose,
  onCreate,
  initialWidth = 1920,
  initialHeight = 1080,
  initialDpi = 300,
  initialName = 'Untitled*',
}) => {
  const presetSelectId = useId();
  const widthInputId = useId();
  const heightInputId = useId();
  const dpiInputId = useId();
  const freqInputId = useId();

  // State
  const [activeCategory, setActiveCategory] = useState<ProjectCategory>('illustration');
  const [selectedPresetId, setSelectedPresetId] = useState<string>('fhd');
  const [documentName, setDocumentName] = useState<string>(initialName);
  const [width, setWidth] = useState<number>(initialWidth);
  const [height, setHeight] = useState<number>(initialHeight);
  const [dpi, setDpi] = useState<number>(initialDpi);
  const [lockRatio, setLockRatio] = useState<boolean>(true);
  const [ratioX, setRatioX] = useState<number>(16);
  const [ratioY, setRatioY] = useState<number>(9);
  const [colorMode, setColorMode] = useState<CanvasColorMode>('color');
  const [defaultFrequency, setDefaultFrequency] = useState<number>(60);
  const [enablePaperColor, setEnablePaperColor] = useState<boolean>(true);
  const [backgroundColor, setBackgroundColor] = useState<string>('#ffffff');
  const [customHex, setCustomHex] = useState<string>('#ffffff');

  // Reset when opened
  useEffect(() => {
    if (isOpen) {
      setDocumentName(initialName);
    }
  }, [isOpen, initialName]);

  // Aspect ratio display string
  const simplifiedRatio = useMemo(() => {
    if (width <= 0 || height <= 0) return '1:1';
    const divisor = gcd(width, height);
    const simpleX = width / divisor;
    const simpleY = height / divisor;
    if (simpleX < 50 && simpleY < 50) {
      return `${simpleX}:${simpleY}`;
    }
    const dec = (width / height).toFixed(2);
    return `${dec}:1`;
  }, [width, height]);

  // Physical Print Dimensions calculated from current width, height, and DPI
  const printDimensions = useMemo(() => {
    const safeDpi = Math.max(1, dpi);
    return {
      cmW: ((width / safeDpi) * 2.54).toFixed(1),
      cmH: ((height / safeDpi) * 2.54).toFixed(1),
      inW: (width / safeDpi).toFixed(2),
      inH: (height / safeDpi).toFixed(2),
    };
  }, [width, height, dpi]);

  const megapixels = useMemo(() => {
    return ((width * height) / 1000000).toFixed(1);
  }, [width, height]);

  const orientation = useMemo(() => {
    if (width > height) return 'Landscape';
    if (height > width) return 'Portrait';
    return 'Square';
  }, [width, height]);

  // Category switch (Use of Work tab selection in CSP)
  const handleSelectCategory = (cat: ProjectCategory) => {
    setActiveCategory(cat);
    if (cat === 'manga') {
      applyPreset('shueisha-manga-a');
    } else if (cat === 'webtoon') {
      applyPreset('webtoon');
    } else if (cat === 'illustration') {
      applyPreset('fhd');
    } else {
      setSelectedPresetId('custom');
    }
  };

  // Preset Selection helper
  const applyPreset = (presetId: string) => {
    setSelectedPresetId(presetId);
    const preset = CANVAS_PRESETS.find((p) => p.id === presetId);
    if (!preset) return;

    setActiveCategory(preset.category);
    setWidth(preset.width);
    setHeight(preset.height);
    setRatioX(preset.ratioX);
    setRatioY(preset.ratioY);
    setDpi(preset.defaultDpi);
    setColorMode(preset.defaultMode);
    if (preset.defaultFrequency) {
      setDefaultFrequency(preset.defaultFrequency);
    }
  };

  const handleSelectPreset = (presetId: string) => {
    applyPreset(presetId);
  };

  // Dimension changes
  const handleWidthChange = (val: number) => {
    const newW = Math.max(1, Math.min(16384, Math.round(val)));
    setWidth(newW);
    if (lockRatio && ratioX > 0 && ratioY > 0) {
      const newH = Math.max(1, Math.round((newW * ratioY) / ratioX));
      setHeight(newH);
    }
    setSelectedPresetId('custom');
    setActiveCategory('custom');
  };

  const handleHeightChange = (val: number) => {
    const newH = Math.max(1, Math.min(16384, Math.round(val)));
    setHeight(newH);
    if (lockRatio && ratioX > 0 && ratioY > 0) {
      const newW = Math.max(1, Math.round((newH * ratioX) / ratioY));
      setWidth(newW);
    }
    setSelectedPresetId('custom');
    setActiveCategory('custom');
  };

  // Swap Width and Height
  const handleSwapDimensions = () => {
    const prevW = width;
    const prevH = height;
    setWidth(prevH);
    setHeight(prevW);
    setRatioX(ratioY);
    setRatioY(ratioX);
    setSelectedPresetId('custom');
  };

  // Resolution DPI change
  const handleDpiSelect = (val: number) => {
    setDpi(val);
  };

  // Submit
  const handleCreate = () => {
    let finalName = documentName.trim() || 'Untitled';
    if (!/\.[a-zA-Z0-9]+$/.test(finalName) && !finalName.endsWith('*')) {
      finalName = `${finalName}*`;
    }

    onCreate({
      name: finalName,
      width,
      height,
      dpi: Math.max(1, Math.round(dpi)),
      aspectRatioPreset: selectedPresetId,
      aspectRatioX: ratioX,
      aspectRatioY: ratioY,
      lockAspectRatio: lockRatio,
      backgroundColor: enablePaperColor ? backgroundColor : 'transparent',
      colorMode,
      defaultFrequency,
    });
    onClose();
  };

  if (!isOpen) return null;

  const isMangaMode = colorMode === 'monochrome' || activeCategory === 'manga';

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-xs p-4 select-none animate-in fade-in duration-100"
      onKeyDown={(e) => {
        if (e.key === 'Escape') onClose();
        if (e.key === 'Enter' && (e.ctrlKey || e.metaKey || e.target instanceof HTMLInputElement)) {
          handleCreate();
        }
      }}
    >
      <div className="bg-[#242426] border border-[#3c3c40] rounded-lg shadow-2xl w-full max-w-4xl flex flex-col overflow-hidden text-xs text-[#d0d0d0]">
        {/* Header Bar */}
        <div className="flex items-center justify-between px-5 py-3 bg-[#2a2a2d] border-b border-[#38383a]">
          <h2 className="text-sm font-semibold text-white tracking-wide">New Canvas</h2>
          <button
            onClick={onClose}
            className="p-1 rounded hover:bg-[#38383a] text-[#888888] hover:text-white transition-colors"
            title="Close (Esc)"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* CSP Style Project Type Bar (Use of Work) */}
        <div className="px-5 py-2.5 bg-[#202022] border-b border-[#323235] flex items-center justify-between gap-2 overflow-x-auto">
          <span className="text-[11px] font-semibold text-[#888888] uppercase tracking-wider shrink-0 mr-1">
            Project Type:
          </span>
          <div className="flex items-center gap-1.5 flex-1 max-w-xl">
            <button
              type="button"
              onClick={() => handleSelectCategory('illustration')}
              className={`flex-1 flex items-center justify-center space-x-1.5 py-1.5 px-3 rounded text-xs transition-colors border ${
                activeCategory === 'illustration'
                  ? 'bg-[#007acc] border-[#007acc] text-white font-medium shadow-xs'
                  : 'bg-[#29292c] border-[#38383c] text-[#b0b0b0] hover:bg-[#323236] hover:text-white'
              }`}
            >
              <Paintbrush className="w-3.5 h-3.5" />
              <span>Illustration</span>
            </button>

            <button
              type="button"
              onClick={() => handleSelectCategory('manga')}
              className={`flex-1 flex items-center justify-center space-x-1.5 py-1.5 px-3 rounded text-xs transition-colors border ${
                activeCategory === 'manga'
                  ? 'bg-[#007acc] border-[#007acc] text-white font-medium shadow-xs'
                  : 'bg-[#29292c] border-[#38383c] text-[#b0b0b0] hover:bg-[#323236] hover:text-white'
              }`}
            >
              <BookOpen className="w-3.5 h-3.5" />
              <span>Comic / Manga</span>
            </button>

            <button
              type="button"
              onClick={() => handleSelectCategory('webtoon')}
              className={`flex-1 flex items-center justify-center space-x-1.5 py-1.5 px-3 rounded text-xs transition-colors border ${
                activeCategory === 'webtoon'
                  ? 'bg-[#007acc] border-[#007acc] text-white font-medium shadow-xs'
                  : 'bg-[#29292c] border-[#38383c] text-[#b0b0b0] hover:bg-[#323236] hover:text-white'
              }`}
            >
              <Smartphone className="w-3.5 h-3.5" />
              <span>Webtoon</span>
            </button>

            <button
              type="button"
              onClick={() => handleSelectCategory('custom')}
              className={`flex-1 flex items-center justify-center space-x-1.5 py-1.5 px-3 rounded text-xs transition-colors border ${
                activeCategory === 'custom'
                  ? 'bg-[#007acc] border-[#007acc] text-white font-medium shadow-xs'
                  : 'bg-[#29292c] border-[#38383c] text-[#b0b0b0] hover:bg-[#323236] hover:text-white'
              }`}
            >
              <Sliders className="w-3.5 h-3.5" />
              <span>Custom</span>
            </button>
          </div>
        </div>

        {/* Modal Main Content */}
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-5 p-5 max-h-[76vh] overflow-y-auto">
          {/* Left Settings Column (7 cols) */}
          <div className="lg:col-span-7 space-y-3.5">
            {/* Document Name & Preset Group */}
            <div className="bg-[#1b1b1d] border border-[#323235] rounded-md p-3 space-y-3">
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div className="space-y-1">
                  <label className="text-[11px] font-semibold text-[#999999] uppercase tracking-wider block">
                    File Name
                  </label>
                  <input
                    type="text"
                    value={documentName}
                    onChange={(e) => setDocumentName(e.target.value)}
                    placeholder="Untitled*"
                    className="w-full bg-[#242427] border border-[#3c3c40] rounded px-3 py-1.5 text-xs text-white focus:outline-hidden focus:border-[#007acc]"
                  />
                </div>

                <div className="space-y-1">
                  <label htmlFor={presetSelectId} className="text-[11px] font-semibold text-[#999999] uppercase tracking-wider block">
                    Preset
                  </label>
                  <select
                    id={presetSelectId}
                    value={selectedPresetId}
                    onChange={(e) => handleSelectPreset(e.target.value)}
                    className="w-full bg-[#242427] border border-[#3c3c40] rounded px-3 py-1.5 text-xs text-white focus:outline-hidden focus:border-[#007acc]"
                  >
                    <optgroup label="--Shueisha--">
                      <option value="shueisha-manga-a">Shueisha manga A (Shonen Jump)</option>
                      <option value="shueisha-manga-b">Shueisha manga B (Young Jump)</option>
                    </optgroup>
                    <optgroup label="Commercial Manga & Print">
                      <option value="manga-b5-600">Manga B5 Commercial (600 DPI)</option>
                      <option value="manga-b5-300">Manga B5 Standard (300 DPI)</option>
                      <option value="a4-300">A4 Document (300 DPI)</option>
                    </optgroup>
                    <optgroup label="Illustration & Screen">
                      <option value="fhd">Full HD (1080p)</option>
                      <option value="4k">4K Ultra HD</option>
                      <option value="square">Square Post / Icon</option>
                      <option value="photo-3-2">Classic Photo (3:2)</option>
                      <option value="cinema">Cinematic Ultrawide (21:9)</option>
                    </optgroup>
                    <optgroup label="Webtoon & Mobile">
                      <option value="webtoon">Webtoon Vertical Episode</option>
                      <option value="story">Mobile Story / Reel (9:16)</option>
                    </optgroup>
                    <optgroup label="Custom">
                      <option value="custom">Custom Size</option>
                    </optgroup>
                  </select>
                </div>
              </div>
            </div>

            {/* Canvas Dimensions & Resolution */}
            <div className="bg-[#1b1b1d] border border-[#323235] rounded-md p-3 space-y-3">
              <div className="flex items-center justify-between">
                <span className="text-[11px] font-semibold text-[#999999] uppercase tracking-wider">
                  Canvas Size & Resolution
                </span>
                <div className="flex items-center space-x-1.5">
                  <button
                    type="button"
                    onClick={() => setLockRatio(!lockRatio)}
                    className={`flex items-center space-x-1 px-2 py-0.5 rounded text-[11px] transition-colors border ${
                      lockRatio
                        ? 'bg-[#007acc]/20 border-[#007acc]/50 text-[#38bdf8]'
                        : 'bg-[#28282b] border-[#38383a] text-[#888888] hover:text-[#cccccc]'
                    }`}
                    title={lockRatio ? 'Ratio locked: editing width preserves aspect' : 'Ratio unlocked'}
                  >
                    {lockRatio ? <Lock className="w-3 h-3" /> : <Unlock className="w-3 h-3" />}
                    <span>{lockRatio ? 'Locked' : 'Free'}</span>
                  </button>
                  <button
                    type="button"
                    onClick={handleSwapDimensions}
                    className="p-1 rounded bg-[#28282b] hover:bg-[#343438] border border-[#38383a] text-[#aaaaaa] hover:text-white transition-colors"
                    title="Swap Width and Height (Landscape ⇄ Portrait)"
                  >
                    <ArrowLeftRight className="w-3.5 h-3.5" />
                  </button>
                </div>
              </div>

              {/* Dimensions Input Row */}
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1">
                  <div className="flex items-center justify-between">
                    <label htmlFor={widthInputId} className="text-[11px] text-[#888888]">Width (px)</label>
                    <span className="text-[10px] text-[#666666] font-mono">{printDimensions.cmW} cm</span>
                  </div>
                  <input
                    id={widthInputId}
                    type="number"
                    min="64"
                    max="16384"
                    value={width}
                    onChange={(e) => handleWidthChange(Number(e.target.value))}
                    className="w-full bg-[#242427] border border-[#3c3c40] rounded px-3 py-1.5 font-mono text-xs text-white focus:outline-hidden focus:border-[#007acc]"
                  />
                </div>

                <div className="space-y-1">
                  <div className="flex items-center justify-between">
                    <label htmlFor={heightInputId} className="text-[11px] text-[#888888]">Height (px)</label>
                    <span className="text-[10px] text-[#666666] font-mono">{printDimensions.cmH} cm</span>
                  </div>
                  <input
                    id={heightInputId}
                    type="number"
                    min="64"
                    max="16384"
                    value={height}
                    onChange={(e) => handleHeightChange(Number(e.target.value))}
                    className="w-full bg-[#242427] border border-[#3c3c40] rounded px-3 py-1.5 font-mono text-xs text-white focus:outline-hidden focus:border-[#007acc]"
                  />
                </div>
              </div>

              {/* Resolution Dropdown & Print dimensions */}
              <div className="pt-2 border-t border-[#2a2a2d] flex items-center justify-between gap-3">
                <div className="flex items-center space-x-2 flex-1">
                  <Printer className="w-3.5 h-3.5 text-[#38bdf8] shrink-0" />
                  <label htmlFor={dpiInputId} className="text-[11px] text-[#888888] whitespace-nowrap">
                    Resolution:
                  </label>
                  <select
                    id={dpiInputId}
                    value={DPI_PRESETS.some((p) => p.dpi === dpi) ? dpi : 'custom'}
                    onChange={(e) => {
                      if (e.target.value !== 'custom') {
                        handleDpiSelect(Number(e.target.value));
                      }
                    }}
                    className="bg-[#242427] border border-[#3c3c40] rounded px-2.5 py-1 text-xs text-white focus:outline-hidden focus:border-[#007acc]"
                  >
                    {DPI_PRESETS.map((p) => (
                      <option key={p.dpi} value={p.dpi}>
                        {p.dpi} DPI ({p.desc})
                      </option>
                    ))}
                    {!DPI_PRESETS.some((p) => p.dpi === dpi) && (
                      <option value="custom">{dpi} DPI (Custom)</option>
                    )}
                  </select>

                  <input
                    type="number"
                    min="1"
                    max="4800"
                    value={dpi}
                    onChange={(e) => setDpi(Math.max(1, Math.min(4800, Number(e.target.value) || 1)))}
                    className="w-16 bg-[#242427] border border-[#3c3c40] rounded px-2 py-1 text-center font-mono text-xs text-white focus:outline-hidden focus:border-[#007acc]"
                    title="Enter custom DPI"
                  />
                  <span className="text-[11px] text-[#666666]">DPI</span>
                </div>

                <div className="text-[11px] text-[#888888] font-mono shrink-0">
                  <span>{printDimensions.cmW} × {printDimensions.cmH} cm</span>
                  <span className="text-[#555555]"> ({printDimensions.inW} × {printDimensions.inH} in)</span>
                </div>
              </div>
            </div>

            {/* Basic Expression Color (CSP Style) */}
            <div className="bg-[#1b1b1d] border border-[#323235] rounded-md p-3 space-y-2.5">
              <div className="flex items-center justify-between">
                <span className="text-[11px] font-semibold text-[#999999] uppercase tracking-wider">
                  Basic Expression Color
                </span>
                <span className="text-[11px] font-medium text-[#38bdf8] capitalize">
                  {colorMode === 'monochrome' ? 'Monochrome (Manga)' : colorMode === 'grayscale' ? 'Grayscale' : 'Color (RGB)'}
                </span>
              </div>

              <div className="grid grid-cols-3 gap-2">
                <button
                  type="button"
                  onClick={() => setColorMode('color')}
                  className={`flex items-center justify-center space-x-2 py-2 px-2.5 rounded border transition-colors ${
                    colorMode === 'color'
                      ? 'bg-[#007acc]/20 border-[#007acc] text-white ring-1 ring-[#007acc]'
                      : 'bg-[#242427] border-[#38383c] text-[#a0a0a0] hover:bg-[#2c2c30] hover:text-white'
                  }`}
                >
                  <span className="w-3 h-3 rounded-full bg-gradient-to-tr from-rose-500 via-emerald-400 to-sky-500 shrink-0" />
                  <span className="font-medium text-xs">Color</span>
                </button>

                <button
                  type="button"
                  onClick={() => setColorMode('grayscale')}
                  className={`flex items-center justify-center space-x-2 py-2 px-2.5 rounded border transition-colors ${
                    colorMode === 'grayscale'
                      ? 'bg-[#007acc]/20 border-[#007acc] text-white ring-1 ring-[#007acc]'
                      : 'bg-[#242427] border-[#38383c] text-[#a0a0a0] hover:bg-[#2c2c30] hover:text-white'
                  }`}
                >
                  <span className="w-3 h-3 rounded-full bg-gradient-to-r from-black via-gray-400 to-white shrink-0" />
                  <span className="font-medium text-xs">Gray</span>
                </button>

                <button
                  type="button"
                  onClick={() => {
                    setColorMode('monochrome');
                    if (dpi < 600) setDpi(600);
                  }}
                  className={`flex items-center justify-center space-x-2 py-2 px-2.5 rounded border transition-colors ${
                    colorMode === 'monochrome'
                      ? 'bg-[#007acc]/20 border-[#007acc] text-white ring-1 ring-[#007acc]'
                      : 'bg-[#242427] border-[#38383c] text-[#a0a0a0] hover:bg-[#2c2c30] hover:text-white'
                  }`}
                >
                  <span className="w-3 h-3 rounded-full border border-white/40 bg-black flex items-center justify-center text-[7px] text-white font-bold shrink-0">
                    B
                  </span>
                  <span className="font-medium text-xs">Monochrome</span>
                </button>
              </div>

              {/* Default Frequency (screentones) - Clip Studio Paint Manga Tone Line Count */}
              {isMangaMode && (
                <div className="pt-2.5 mt-2 border-t border-[#2a2a2d] space-y-2 animate-in fade-in duration-150">
                  <div className="flex items-center justify-between">
                    <span className="text-[11px] font-semibold text-[#aaaaaa]">
                      Default Frequency (screentones): <strong className="text-amber-300 font-mono">{defaultFrequency} LPI</strong>
                    </span>
                    <span className="text-[10px] text-[#777777] font-mono">20 to 85 LPI</span>
                  </div>

                  <div className="flex items-center space-x-3">
                    <input
                      type="range"
                      min="20"
                      max="85"
                      step="0.5"
                      value={defaultFrequency}
                      onChange={(e) => setDefaultFrequency(Number(e.target.value))}
                      className="flex-1 cursor-pointer h-1.5 accent-[#007acc]"
                    />
                    <input
                      id={freqInputId}
                      type="number"
                      min="20"
                      max="85"
                      step="0.5"
                      value={defaultFrequency}
                      onChange={(e) => setDefaultFrequency(Math.max(20, Math.min(85, Number(e.target.value) || 60)))}
                      className="w-14 bg-[#242427] border border-[#3c3c40] rounded px-2 py-0.5 text-center font-mono text-xs text-white focus:outline-hidden focus:border-[#007acc]"
                    />
                  </div>

                  {/* Quick frequency presets */}
                  <div className="flex items-center gap-1.5 pt-0.5">
                    <span className="text-[10px] text-[#777777] mr-1">Common:</span>
                    {COMMON_FREQUENCIES.map((f) => (
                      <button
                        key={f}
                        type="button"
                        onClick={() => setDefaultFrequency(f)}
                        className={`px-2 py-0.5 rounded text-[10px] font-mono border transition-colors ${
                          defaultFrequency === f
                            ? 'bg-amber-400/20 border-amber-400/60 text-amber-300 font-bold'
                            : 'bg-[#242427] border-[#38383c] text-[#999999] hover:bg-[#303034] hover:text-white'
                        }`}
                      >
                        {f}L
                      </button>
                    ))}
                  </div>
                </div>
              )}
            </div>

            {/* Paper Color (Background) */}
            <div className="bg-[#1b1b1d] border border-[#323235] rounded-md p-3 space-y-2.5">
              <div className="flex items-center justify-between">
                <label className="flex items-center space-x-2 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={enablePaperColor}
                    onChange={(e) => setEnablePaperColor(e.target.checked)}
                    className="w-3.5 h-3.5 rounded accent-[#007acc] cursor-pointer"
                  />
                  <span className="text-[11px] font-semibold text-[#999999] uppercase tracking-wider">
                    Paper Color
                  </span>
                </label>
                <span className="text-[11px] text-[#777777]">
                  {enablePaperColor ? backgroundColor.toUpperCase() : 'Transparent'}
                </span>
              </div>

              {enablePaperColor && (
                <div className="flex items-center flex-wrap gap-2 pt-1">
                  {BG_PRESETS.map((bg) => {
                    const isSelected = backgroundColor.toLowerCase() === bg.value.toLowerCase();
                    return (
                      <button
                        key={bg.label}
                        type="button"
                        onClick={() => {
                          setBackgroundColor(bg.value);
                          setCustomHex(bg.value);
                        }}
                        className={`flex items-center space-x-1.5 px-2.5 py-1 rounded text-xs border transition-colors ${
                          isSelected
                            ? 'border-[#007acc] bg-[#007acc]/15 text-white ring-1 ring-[#007acc]'
                            : 'border-[#38383c] bg-[#242427] text-[#cccccc] hover:bg-[#2c2c30]'
                        }`}
                      >
                        <span
                          className="w-3 h-3 rounded-full border border-black/40 shrink-0"
                          style={{ backgroundColor: bg.color }}
                        />
                        <span>{bg.label}</span>
                      </button>
                    );
                  })}

                  {/* Custom Color Input */}
                  <div className="flex items-center space-x-1.5 bg-[#242427] border border-[#38383c] rounded px-2 py-0.5 ml-auto">
                    <Palette className="w-3.5 h-3.5 text-[#888888]" />
                    <input
                      type="color"
                      value={customHex.startsWith('#') ? customHex : '#ffffff'}
                      onChange={(e) => {
                        setCustomHex(e.target.value);
                        setBackgroundColor(e.target.value);
                      }}
                      className="w-4 h-4 cursor-pointer bg-transparent border-none rounded"
                      title="Pick custom color"
                    />
                    <input
                      type="text"
                      value={customHex}
                      onChange={(e) => {
                        setCustomHex(e.target.value);
                        if (e.target.value.startsWith('#') && e.target.value.length >= 4) {
                          setBackgroundColor(e.target.value);
                        }
                      }}
                      className="w-16 bg-transparent font-mono text-[11px] text-white focus:outline-hidden"
                    />
                  </div>
                </div>
              )}
            </div>
          </div>

          {/* Right Column: Live Proportional Manuscript Preview (5 cols) */}
          <div className="lg:col-span-5 flex flex-col space-y-3">
            <span className="text-[11px] font-semibold text-[#888888] uppercase tracking-wider">
              Canvas Ratio Preview
            </span>

            <div className="flex-1 bg-[#18181a] border border-[#323235] rounded-md p-4 flex flex-col items-center justify-between min-h-[300px] relative overflow-hidden">
              {/* Proportional Page Preview Area */}
              <div
                className="w-full h-48 rounded-sm flex items-center justify-center relative p-3 overflow-hidden shadow-inner"
                style={{
                  backgroundImage: `conic-gradient(#202022 90deg, #161618 90deg 180deg, #202022 180deg 270deg, #161618 270deg)`,
                  backgroundSize: '16px 16px',
                }}
              >
                {/* Dynamically Scaled Page Representation */}
                <div
                  className="max-w-full max-h-full transition-all duration-200 rounded-[2px] shadow-xl relative border border-black/70 flex items-center justify-center overflow-hidden"
                  style={{
                    aspectRatio: `${Math.max(1, width)} / ${Math.max(1, height)}`,
                    width: width >= height ? '90%' : 'auto',
                    height: height > width ? '95%' : 'auto',
                    backgroundColor: enablePaperColor ? backgroundColor : undefined,
                    backgroundImage:
                      !enablePaperColor
                        ? 'conic-gradient(#888 90deg, #555 90deg 180deg, #888 180deg 270deg, #555 270deg)'
                        : undefined,
                    backgroundSize: '10px 10px',
                  }}
                >
                  {/* Subtle Manga Margin / Safe Bleed Line Guides (CSP Manuscript Overlay) */}
                  {isMangaMode && (
                    <div className="absolute inset-2 border border-sky-400/30 border-dashed pointer-events-none flex items-center justify-center">
                      <div className="absolute inset-2 border border-sky-400/20 pointer-events-none" />
                    </div>
                  )}

                  {/* Ratio badge inside page preview */}
                  <span
                    className={`text-[9px] font-mono px-1.5 py-0.5 rounded shadow-sm font-semibold select-none z-10 ${
                      enablePaperColor && (backgroundColor === '#000000' || backgroundColor === '#1e1e1e')
                        ? 'bg-white/20 text-white'
                        : 'bg-black/60 text-white'
                    }`}
                  >
                    {simplifiedRatio}
                  </span>
                </div>
              </div>

              {/* Informative Specs Card */}
              <div className="w-full mt-3 bg-[#1f1f22] border border-[#2b2b2e] rounded p-3 space-y-1.5 text-[11px]">
                <div className="flex items-center justify-between text-[#aaaaaa]">
                  <span>Resolution:</span>
                  <span className="font-mono text-white font-medium">
                    {width} × {height} px
                  </span>
                </div>

                <div className="flex items-center justify-between text-[#aaaaaa]">
                  <span>Aspect Ratio:</span>
                  <span className="font-mono text-[#38bdf8] font-medium">
                    {simplifiedRatio} ({(width / height).toFixed(2)}:1)
                  </span>
                </div>

                <div className="flex items-center justify-between text-[#aaaaaa]">
                  <span>Print Size:</span>
                  <span className="font-mono text-[#e0e0e0]">
                    {printDimensions.cmW} × {printDimensions.cmH} cm
                  </span>
                </div>

                <div className="flex items-center justify-between text-[#aaaaaa]">
                  <span>Density:</span>
                  <span className="font-mono text-[#38bdf8] font-medium">
                    {dpi} DPI ({megapixels} MP)
                  </span>
                </div>

                <div className="flex items-center justify-between text-[#aaaaaa]">
                  <span>Orientation:</span>
                  <span className="text-[#e0e0e0] font-medium">
                    {orientation}
                  </span>
                </div>

                <div className="flex items-center justify-between text-[#aaaaaa] pt-1.5 border-t border-[#2d2d30]">
                  <span>Expression Color:</span>
                  <span
                    className={`font-semibold capitalize ${
                      colorMode === 'monochrome'
                        ? 'text-amber-400'
                        : colorMode === 'grayscale'
                        ? 'text-slate-300'
                        : 'text-emerald-400'
                    }`}
                  >
                    {colorMode === 'monochrome' ? `Monochrome (${defaultFrequency}L tone)` : colorMode}
                  </span>
                </div>
              </div>
            </div>
          </div>
        </div>

        {/* Modal Footer Actions */}
        <div className="flex items-center justify-between px-5 py-3 bg-[#2a2a2d] border-t border-[#38383a]">
          <div className="text-[11px] text-[#777777] hidden sm:block">
            Press <kbd className="px-1.5 py-0.5 rounded bg-[#1c1c1e] border border-[#3e3e42] text-[#aaaaaa]">Enter</kbd> to Create
          </div>

          <div className="flex items-center space-x-2.5 ml-auto">
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-1.5 rounded bg-[#333336] hover:bg-[#3d3d42] text-[#cccccc] hover:text-white border border-[#444448] transition-colors"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={handleCreate}
              className="flex items-center space-x-1.5 px-5 py-1.5 rounded bg-[#007acc] hover:bg-[#008be5] active:bg-[#006bb3] text-white font-medium shadow-sm transition-colors"
            >
              <FileCheck className="w-4 h-4" />
              <span>Create Canvas</span>
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};
