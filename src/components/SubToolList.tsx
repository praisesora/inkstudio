import React, { useState, useRef } from 'react';
import {
  Paintbrush,
  PenTool,
  Pencil,
  Plus,
  Trash2,
  Loader2,
  FolderDown,
  Sparkles,
  ChevronDown,
  ChevronRight,
} from 'lucide-react';
import { BrushCategory, BrushPresetId, CspBrush } from '../types/editor';
import { parseSutFile } from '../utils/sutParser';
import {
  saveCustomBrush,
  deleteCustomBrush,
  prepareBrushSettingsForCsp,
} from '../utils/brushStorage';
import {
  BUILTIN_BRUSHES,
  BUILTIN_BRUSH_SECTIONS,
  BuiltinBrushDefinition,
} from '../utils/presetBrushes';
import {
  DEFAULT_BRUSH_PRESET_ID,
  NEUTRAL_BRUSH_DEFAULTS,
  getEffectiveBrushSettings,
  getSavedBrushSettings,
  saveActivePresetId,
} from '../utils/brushPresetManager';
import { useToolStore, toolStoreActions } from '../stores';

export interface SubToolListProps {
  customBrushes: CspBrush[];
  setCustomBrushes: React.Dispatch<React.SetStateAction<CspBrush[]>>;
}

function renderBuiltinIcon(icon: BuiltinBrushDefinition['icon']) {
  if (icon === 'pen') return <PenTool className="w-3 h-3 shrink-0 opacity-80" />;
  if (icon === 'pencil') return <Pencil className="w-3 h-3 shrink-0 opacity-80" />;
  return <Paintbrush className="w-3 h-3 shrink-0 opacity-80" />;
}

export const SubToolList: React.FC<SubToolListProps> = React.memo(
  ({ customBrushes, setCustomBrushes }) => {
    const currentTool = useToolStore((s) => s.tool);
    const activePreset = useToolStore((s) => s.brushSettings.preset);

    const [isImportingSut, setIsImportingSut] = useState(false);
    const [isDraggingFileOver, setIsDraggingFileOver] = useState(false);
    const [collapsedSections, setCollapsedSections] = useState<Record<string, boolean>>({});
    const sutInputRef = useRef<HTMLInputElement>(null);

    const toggleSection = (key: string) => {
      setCollapsedSections((prev) => ({ ...prev, [key]: !prev[key] }));
    };

    const handleSelectBrushPreset = (presetId: BrushPresetId) => {
      toolStoreActions.selectTool('brush');
      saveActivePresetId(presetId);
      const effective = getEffectiveBrushSettings(presetId, customBrushes);
      toolStoreActions.updateBrushSettings({
        ...NEUTRAL_BRUSH_DEFAULTS,
        ...effective,
        preset: presetId,
      });
    };

    const handleSelectCustomBrush = async (brush: CspBrush) => {
      toolStoreActions.selectTool('brush');
      saveActivePresetId(brush.id);
      const prepared = await prepareBrushSettingsForCsp(brush);
      const saved = getSavedBrushSettings(brush.id);
      toolStoreActions.updateBrushSettings({
        ...NEUTRAL_BRUSH_DEFAULTS,
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
            (b) =>
              b.name.toLowerCase() !== parsedBrush.name.toLowerCase() && b.id !== parsedBrush.id
          ),
        ]);
        await handleSelectCustomBrush(parsedBrush);
      } catch (err: unknown) {
        const msg =
          err instanceof Error ? err.message : 'Failed to import Clip Studio Paint brush file.';
        alert(msg);
      } finally {
        setIsImportingSut(false);
      }
    };

    const handleDeleteCustomBrush = async (e: React.MouseEvent, brushId: string) => {
      e.stopPropagation();
      if (window.confirm('Delete this imported brush?')) {
        await deleteCustomBrush(brushId);
        setCustomBrushes((prev) => prev.filter((b) => b.id !== brushId));
        if (activePreset === brushId) {
          handleSelectBrushPreset(DEFAULT_BRUSH_PRESET_ID);
        }
      }
    };

    const brushesByCategory = (cat: BrushCategory) =>
      BUILTIN_BRUSHES.filter((b) => b.category === cat);

    return (
      <>
        <div className="px-1.5 py-1 flex items-center justify-end shrink-0">
          <button
            type="button"
            onClick={() => sutInputRef.current?.click()}
            title="Import CSP Brush (.sut)"
            className="h-5 px-1.5 rounded flex items-center gap-1 text-[10px] text-[#8a8a8a] hover:text-[#e5e5e5] hover:bg-[#2c2c2c] shrink-0 cursor-pointer"
          >
            <Plus className="w-3 h-3" />
            <span>Import .sut</span>
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

        {/* Compact High-Density Sectioned Sub-Tool List */}
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
          className="flex-1 overflow-y-auto px-1.5 py-0.5 space-y-1 relative min-h-[84px]"
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

          {BUILTIN_BRUSH_SECTIONS.map((section) => {
            const items = brushesByCategory(section.id);
            if (items.length === 0) return null;
            const isCollapsed = Boolean(collapsedSections[section.id]);

            return (
              <div key={section.id} className="space-y-0.5">
                <button
                  type="button"
                  onClick={() => toggleSection(section.id)}
                  className="w-full flex items-center gap-1 px-1 py-0.5 text-[9px] uppercase tracking-wider text-[#6e6e6e] hover:text-[#b5b5b5] select-none cursor-pointer"
                >
                  {isCollapsed ? (
                    <ChevronRight className="w-2.5 h-2.5 shrink-0" />
                  ) : (
                    <ChevronDown className="w-2.5 h-2.5 shrink-0" />
                  )}
                  <span>{section.label}</span>
                </button>

                {!isCollapsed &&
                  items.map((item) => {
                    const isSelected =
                      currentTool === 'brush' &&
                      (activePreset === item.id ||
                        (!activePreset && item.id === DEFAULT_BRUSH_PRESET_ID));

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
                        {renderBuiltinIcon(item.icon)}
                        <span className="text-[11px] truncate leading-tight flex-1">
                          {item.name}
                        </span>
                      </button>
                    );
                  })}
              </div>
            );
          })}

          {customBrushes.length > 0 && (
            <div className="space-y-0.5 pt-0.5">
              <button
                type="button"
                onClick={() => toggleSection('custom')}
                className="w-full flex items-center gap-1 px-1 py-0.5 text-[9px] uppercase tracking-wider text-[#6e6e6e] hover:text-[#b5b5b5] select-none cursor-pointer"
              >
                {collapsedSections.custom ? (
                  <ChevronRight className="w-2.5 h-2.5 shrink-0" />
                ) : (
                  <ChevronDown className="w-2.5 h-2.5 shrink-0" />
                )}
                <span>Imported</span>
              </button>

              {!collapsedSections.custom &&
                customBrushes.map((brush) => {
                  const isSelected = currentTool === 'brush' && activePreset === brush.id;
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
            </div>
          )}
        </div>
      </>
    );
  }
);

SubToolList.displayName = 'SubToolList';
