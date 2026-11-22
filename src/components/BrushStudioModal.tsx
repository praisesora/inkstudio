import React, { useState, useEffect, useCallback } from 'react';
import {
  X,
  Paintbrush,
  Spline,
  Grid3X3,
  Layers,
  Droplets,
  Sparkles,
  Sliders,
  Info,
} from 'lucide-react';
import type { BrushCategory, BrushSettings, CspBrush } from '../types/editor';
import { useToolStore, toolStoreActions } from '../stores';
import { BUILTIN_BRUSHES } from '../utils/presetBrushes';
import {
  DEFAULT_BRUSH_PRESET_ID,
  NEUTRAL_BRUSH_DEFAULTS,
  resetBrushSettingsToDefault,
  saveActivePresetId,
} from '../utils/brushPresetManager';
import {
  getCachedCustomBrushes,
  prepareBrushSettingsForCsp,
  saveCustomBrush,
  saveCustomBrushDebounced,
} from '../utils/brushStorage';
import {
  buildExportableBrush,
  exportBrushToInkbFile,
  importBrushFile,
} from '../utils/inkbBrushFormat';
import { BrushStudioScratchpad } from './brushStudio/BrushStudioScratchpad';
import {
  DualBrushTab,
  ShapeBristlesTab,
  StrokeTaperTab,
  TextureGrainTab,
} from './brushStudio/BrushStudioTabsPrimary';
import {
  AboutPresetsTab,
  DynamicsSensorMatrixTab,
  ImpastoWetEdgeTab,
  NaturalPaintMixingTab,
} from './brushStudio/BrushStudioTabsSecondary';

type StudioTabId =
  | 'shape'
  | 'stroke'
  | 'texture'
  | 'dual'
  | 'mixing'
  | 'impasto'
  | 'dynamics'
  | 'about';

const STUDIO_TABS: Array<{ id: StudioTabId; label: string; icon: React.ReactNode }> = [
  { id: 'shape', label: 'Shape & Bristles', icon: <Paintbrush className="w-3.5 h-3.5" /> },
  { id: 'stroke', label: 'Stroke & Taper', icon: <Spline className="w-3.5 h-3.5" /> },
  { id: 'texture', label: 'Texture & Grain', icon: <Grid3X3 className="w-3.5 h-3.5" /> },
  { id: 'dual', label: 'Dual Brush', icon: <Layers className="w-3.5 h-3.5" /> },
  { id: 'mixing', label: 'Natural Paint', icon: <Droplets className="w-3.5 h-3.5" /> },
  { id: 'impasto', label: 'Impasto & Wet', icon: <Sparkles className="w-3.5 h-3.5" /> },
  { id: 'dynamics', label: 'Sensor Matrix', icon: <Sliders className="w-3.5 h-3.5" /> },
  { id: 'about', label: 'About & Presets', icon: <Info className="w-3.5 h-3.5" /> },
];

export interface BrushStudioModalProps {
  isOpen: boolean;
  onClose: () => void;
  showToast?: (msg: string) => void;
}

export const BrushStudioModal: React.FC<BrushStudioModalProps> = ({
  isOpen,
  onClose,
  showToast,
}) => {
  const brushSettings = useToolStore((s) => s.brushSettings);
  const activePreset = useToolStore((s) => s.activePresetId) || DEFAULT_BRUSH_PRESET_ID;

  const [activeTab, setActiveTab] = useState<StudioTabId>('shape');
  const [brushName, setBrushName] = useState<string>(brushSettings.brushName || 'Brush');
  const [category, setCategory] = useState<BrushCategory | 'custom'>('natural-paint');
  const [description, setDescription] = useState<string>('');

  useEffect(() => {
    if (!isOpen) return;
    const builtin = BUILTIN_BRUSHES.find((b) => b.id === activePreset);
    const custom = getCachedCustomBrushes().find((b) => b.id === activePreset);
    setBrushName(custom?.name || builtin?.name || brushSettings.brushName || 'Custom Brush');
    setCategory(custom?.category || builtin?.category || 'custom');
    setDescription(custom?.desc || builtin?.desc || '');
  }, [isOpen, activePreset, brushSettings.brushName]);

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

  const handlePatchSettings = useCallback(
    (patch: Partial<BrushSettings>) => {
      toolStoreActions.updateBrushSettings(patch);
      const custom = getCachedCustomBrushes().find((b) => b.id === activePreset);
      if (custom) {
        const merged = { ...useToolStore.getState().brushSettings, ...patch };
        const updated: CspBrush = {
          ...buildExportableBrush(activePreset, getCachedCustomBrushes(), merged),
          id: custom.id,
          name: brushName || custom.name,
          category,
          desc: description,
          badge: custom.badge || 'INKB',
        };
        saveCustomBrushDebounced(updated);
      }
    },
    [activePreset, brushName, category, description]
  );

  const handleSaveAsNewPreset = async (suffix: string = '') => {
    const live = useToolStore.getState().brushSettings;
    const baseName = (brushName || live.brushName || 'Custom Brush').trim();
    const finalName = suffix ? `${baseName} ${suffix}` : baseName;
    const id = `inkb-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
    const exported = buildExportableBrush(activePreset, getCachedCustomBrushes(), live);
    const newBrush: CspBrush = {
      ...exported,
      id,
      name: finalName,
      category,
      desc: description || exported.desc,
      badge: 'Studio',
      importedAt: Date.now(),
    };
    await saveCustomBrush(newBrush);
    saveActivePresetId(newBrush.id);
    const prepared = await prepareBrushSettingsForCsp(newBrush);
    toolStoreActions.updateBrushSettings({
      ...NEUTRAL_BRUSH_DEFAULTS,
      ...prepared,
      preset: newBrush.id,
    });
    showToast?.(`Saved preset "${finalName}"`);
  };

  const handleResetDefault = () => {
    const restored = resetBrushSettingsToDefault(activePreset, getCachedCustomBrushes());
    toolStoreActions.updateBrushSettings({
      ...NEUTRAL_BRUSH_DEFAULTS,
      ...restored,
      preset: activePreset,
    });
    showToast?.('Brush reset to default');
  };

  const handleExportInkb = async () => {
    try {
      const live = useToolStore.getState().brushSettings;
      const exportBrush: CspBrush = {
        ...buildExportableBrush(activePreset, getCachedCustomBrushes(), live),
        name: brushName || live.brushName || activePreset,
        category,
        desc: description,
      };
      const res = await exportBrushToInkbFile(exportBrush);
      if (res.exported) showToast?.(`Exported ${res.fileName}`);
    } catch (err) {
      showToast?.(err instanceof Error ? err.message : 'Export failed');
    }
  };

  const handleImportInkb = async (file: File) => {
    try {
      const parsed = await importBrushFile(file);
      saveActivePresetId(parsed.id);
      showToast?.(`Imported "${parsed.name}"`);
    } catch (err) {
      showToast?.(err instanceof Error ? err.message : 'Import failed');
    }
  };

  if (!isOpen) return null;

  return (
    <div
      className="fixed inset-0 z-50 bg-black/70 backdrop-blur-xs flex items-center justify-center p-4"
      onPointerDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="w-full max-w-[1060px] h-[min(86vh,720px)] bg-[#202020] border border-white/12 rounded-xl shadow-2xl flex flex-col overflow-hidden text-[#e5e5e5]">
        {/* Header */}
        <div className="px-4 py-2.5 bg-[#191919] border-b border-white/[0.08] flex items-center justify-between gap-3 shrink-0">
          <div className="flex items-center gap-2 min-w-0">
            <Paintbrush className="w-4 h-4 text-[var(--accent)] shrink-0" />
            <h2 className="text-[13px] font-semibold tracking-tight truncate">
              Brush Studio — {brushName}
            </h2>
            <span className="text-[10px] px-1.5 py-0.5 rounded bg-white/[0.06] text-[#a3a3a3] uppercase">
              {brushSettings.renderMode ?? 'stamp'}
            </span>
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => handleSaveAsNewPreset()}
              className="px-2.5 py-1 rounded bg-[var(--accent)] hover:opacity-90 text-[11px] font-medium text-white cursor-pointer"
            >
              Save New Preset
            </button>
            <button
              type="button"
              onClick={onClose}
              title="Close Brush Studio (Esc)"
              className="p-1 rounded text-[#8a8a8a] hover:text-white hover:bg-white/10 cursor-pointer"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>

        {/* Main 3-Column Layout: Tabs | Scratchpad | Inspector */}
        <div className="flex-1 flex min-h-0">
          {/* Left Tab Rail */}
          <nav className="w-[156px] bg-[#181818] border-r border-white/[0.08] p-2 space-y-0.5 shrink-0 overflow-y-auto">
            {STUDIO_TABS.map((tab) => {
              const selected = activeTab === tab.id;
              return (
                <button
                  key={tab.id}
                  type="button"
                  onClick={() => setActiveTab(tab.id)}
                  className={`w-full flex items-center gap-2 px-2.5 py-2 rounded-md text-[11px] transition-colors cursor-pointer ${
                    selected
                      ? 'bg-[#2c2c2c] text-white font-medium border border-white/[0.08]'
                      : 'text-[#8a8a8a] hover:text-[#e5e5e5] hover:bg-white/[0.04]'
                  }`}
                >
                  <span className={selected ? 'text-[var(--accent)]' : 'opacity-75'}>
                    {tab.icon}
                  </span>
                  <span className="truncate">{tab.label}</span>
                </button>
              );
            })}
          </nav>

          {/* Center Interactive Live Scratchpad */}
          <div className="flex-1 min-w-[320px] flex flex-col">
            <BrushStudioScratchpad brushSettings={brushSettings} />
          </div>

          {/* Right Parameter Inspector */}
          <div className="w-[370px] bg-[#1e1e1e] p-3.5 overflow-y-auto shrink-0">
            {activeTab === 'shape' && (
              <ShapeBristlesTab bs={brushSettings} onPatch={handlePatchSettings} />
            )}
            {activeTab === 'stroke' && (
              <StrokeTaperTab bs={brushSettings} onPatch={handlePatchSettings} />
            )}
            {activeTab === 'texture' && (
              <TextureGrainTab bs={brushSettings} onPatch={handlePatchSettings} />
            )}
            {activeTab === 'dual' && (
              <DualBrushTab bs={brushSettings} onPatch={handlePatchSettings} />
            )}
            {activeTab === 'mixing' && (
              <NaturalPaintMixingTab bs={brushSettings} onPatch={handlePatchSettings} />
            )}
            {activeTab === 'impasto' && (
              <ImpastoWetEdgeTab bs={brushSettings} onPatch={handlePatchSettings} />
            )}
            {activeTab === 'dynamics' && (
              <DynamicsSensorMatrixTab bs={brushSettings} onPatch={handlePatchSettings} />
            )}
            {activeTab === 'about' && (
              <AboutPresetsTab
                bs={brushSettings}
                onPatch={handlePatchSettings}
                brushName={brushName}
                onBrushNameChange={(name) => {
                  setBrushName(name);
                  handlePatchSettings({ brushName: name });
                }}
                category={category}
                onCategoryChange={setCategory}
                description={description}
                onDescriptionChange={setDescription}
                onResetDefault={handleResetDefault}
                onSaveAsNewPreset={() => handleSaveAsNewPreset()}
                onDuplicateBrush={() => handleSaveAsNewPreset('Copy')}
                onExportInkb={handleExportInkb}
                onImportInkb={handleImportInkb}
              />
            )}
          </div>
        </div>
      </div>
    </div>
  );
};
