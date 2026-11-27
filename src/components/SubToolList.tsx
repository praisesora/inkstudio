import React, { useState, useRef } from 'react';
import {
  Droplets,
  Paintbrush,
  Palette,
  PenTool,
  Pencil,
  Plus,
  Copy,
  Download,
  Trash2,
  Loader2,
  FolderDown,
  ChevronDown,
  ChevronRight,
  Sliders,
  AlertTriangle,
} from 'lucide-react';
import { BrushCategory, BrushPresetId, CspBrush } from '../types/editor';
import {
  buildExportableBrush,
  exportBrushToInkbFile,
  importBrushFile,
  isSupportedBrushFileName,
} from '../utils/inkbBrushFormat';
import {
  deleteCustomBrush,
  prepareBrushSettingsForCsp,
  saveCustomBrush,
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
import { useToolStore, toolStoreActions, uiStoreActions } from '../stores';

export interface SubToolListProps {
  customBrushes: CspBrush[];
  setCustomBrushes: React.Dispatch<React.SetStateAction<CspBrush[]>>;
}

function renderBuiltinIcon(icon: BuiltinBrushDefinition['icon']) {
  if (icon === 'pen') return <PenTool className="w-3 h-3 shrink-0 opacity-80" />;
  if (icon === 'pencil') return <Pencil className="w-3 h-3 shrink-0 opacity-80" />;
  if (icon === 'droplets') return <Droplets className="w-3 h-3 shrink-0 text-sky-300/85" />;
  if (icon === 'palette') return <Palette className="w-3 h-3 shrink-0 text-rose-300/85" />;
  return <Paintbrush className="w-3 h-3 shrink-0 opacity-80" />;
}

export const SubToolList: React.FC<SubToolListProps> = React.memo(
  ({ customBrushes, setCustomBrushes }) => {
    const currentTool = useToolStore((s) => s.tool);
    const activePreset = useToolStore((s) => s.activePresetId);

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

    const handleImportBrush = async (file: File) => {
      setIsImportingSut(true);
      try {
        const parsedBrush = await importBrushFile(file);
        setCustomBrushes((prev) => [
          parsedBrush,
          ...prev.filter(
            (b) =>
              b.name.toLowerCase() !== parsedBrush.name.toLowerCase() && b.id !== parsedBrush.id
          ),
        ]);
        saveActivePresetId(parsedBrush.id);
        if (parsedBrush.importWarnings && parsedBrush.importWarnings.length > 0) {
          const count = parsedBrush.importWarnings.length;
          const first = parsedBrush.importWarnings[0];
          uiStoreActions.showToast(
            count === 1
              ? `Imported "${parsedBrush.name}" (Notice: ${first})`
              : `Imported "${parsedBrush.name}" with ${count} CSP import notices — check inspector`
          );
        } else {
          uiStoreActions.showToast(`Imported brush "${parsedBrush.name}"`);
        }
      } catch (err: unknown) {
        const msg =
          err instanceof Error ? err.message : 'Failed to import brush file.';
        void uiStoreActions.alertDialog({
          title: 'Brush Import Failed',
          message: msg,
        });
      } finally {
        setIsImportingSut(false);
      }
    };

    const handleExportBrush = async (presetId: string, e?: React.MouseEvent) => {
      e?.stopPropagation();
      try {
        const liveSettings = useToolStore.getState().brushSettings;
        const brush = buildExportableBrush(presetId, customBrushes, liveSettings);
        await exportBrushToInkbFile(brush);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : 'Failed to export brush.';
        void uiStoreActions.alertDialog({
          title: 'Brush Export Failed',
          message: msg,
        });
      }
    };

    const handleDeleteCustomBrush = async (e: React.MouseEvent, brush: CspBrush) => {
      e.stopPropagation();
      const subtitle = brush.badge
        ? `${brush.badge} brush`
        : 'Imported custom brush';
      const confirmed = await uiStoreActions.confirmDialog({
        variant: 'danger',
        title: 'Delete Brush',
        message: 'Are you sure you want to delete this brush?',
        detail: 'This permanently removes the brush from your library and cannot be undone.',
        confirmLabel: 'Delete',
        cancelLabel: 'Cancel',
        preview: {
          imageUrl: brush.tipDataUrl,
          title: brush.name,
          subtitle,
        },
      });
      if (confirmed) {
        await deleteCustomBrush(brush.id);
        setCustomBrushes((prev) => prev.filter((b) => b.id !== brush.id));
        if (activePreset === brush.id) {
          handleSelectBrushPreset(DEFAULT_BRUSH_PRESET_ID);
        }
      }
    };

    const handleCreateNewBrush = async () => {
      const id = `inkb-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
      const base = buildExportableBrush('impasto-bristle-oil', customBrushes);
      const newBrush: CspBrush = {
        ...base,
        id,
        name: 'New Natural Brush',
        category: 'natural-paint',
        badge: 'Studio',
        importedAt: Date.now(),
      };
      await saveCustomBrush(newBrush);
      setCustomBrushes((prev) => [newBrush, ...prev]);
      await handleSelectCustomBrush(newBrush);
      uiStoreActions.setBrushStudioModalOpen(true);
    };

    const handleDuplicateActiveBrush = async () => {
      const sourceId = activePreset || DEFAULT_BRUSH_PRESET_ID;
      const liveSettings = useToolStore.getState().brushSettings;
      const exported = buildExportableBrush(sourceId, customBrushes, liveSettings);
      const id = `inkb-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
      const dupBrush: CspBrush = {
        ...exported,
        id,
        name: `${exported.name} Copy`,
        badge: 'Studio',
        importedAt: Date.now(),
      };
      await saveCustomBrush(dupBrush);
      setCustomBrushes((prev) => [dupBrush, ...prev]);
      await handleSelectCustomBrush(dupBrush);
      uiStoreActions.setBrushStudioModalOpen(true);
    };

    const brushesByCategory = (cat: BrushCategory) =>
      BUILTIN_BRUSHES.filter((b) => b.category === cat);

    return (
      <>
        <div className="px-1.5 py-1 flex items-center justify-between gap-0.5 shrink-0">
          <div className="flex items-center gap-0.5">
            <button
              type="button"
              onClick={handleCreateNewBrush}
              title="Create New Brush in Brush Studio"
              className="h-5 px-1 rounded flex items-center gap-0.5 text-[10px] text-[#8a8a8a] hover:text-[#e5e5e5] hover:bg-[#2c2c2c] shrink-0 cursor-pointer"
            >
              <Plus className="w-3 h-3" />
              <span>New</span>
            </button>
            <button
              type="button"
              onClick={handleDuplicateActiveBrush}
              title="Duplicate Active Brush"
              className="h-5 px-1 rounded flex items-center text-[10px] text-[#8a8a8a] hover:text-[#e5e5e5] hover:bg-[#2c2c2c] shrink-0 cursor-pointer"
            >
              <Copy className="w-2.5 h-2.5" />
            </button>
            <button
              type="button"
              onClick={() => uiStoreActions.setBrushStudioModalOpen(true)}
              title="Edit Active Brush in Brush Studio"
              className="h-5 px-1 rounded flex items-center text-[10px] text-[#8a8a8a] hover:text-[var(--accent)] hover:bg-[#2c2c2c] shrink-0 cursor-pointer"
            >
              <Sliders className="w-2.5 h-2.5" />
            </button>
          </div>
          <div className="flex items-center gap-0.5">
            <button
              type="button"
              onClick={() => sutInputRef.current?.click()}
              title="Import Brush (.inkb, .sut)"
              className="h-5 px-1 rounded flex items-center gap-0.5 text-[10px] text-[#8a8a8a] hover:text-[#e5e5e5] hover:bg-[#2c2c2c] shrink-0 cursor-pointer"
            >
              <FolderDown className="w-2.5 h-2.5" />
            </button>
            <button
              type="button"
              onClick={() => handleExportBrush(activePreset || DEFAULT_BRUSH_PRESET_ID)}
              title="Export Active Brush (.inkb)"
              className="h-5 px-1 rounded flex items-center gap-0.5 text-[10px] text-[#8a8a8a] hover:text-[#e5e5e5] hover:bg-[#2c2c2c] shrink-0 cursor-pointer"
            >
              <Download className="w-2.5 h-2.5" />
            </button>
          </div>
        </div>

        <input
          type="file"
          ref={sutInputRef}
          accept=".inkb,.sut"
          className="hidden"
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) handleImportBrush(file);
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
              isSupportedBrushFileName(f.name)
            );
            for (const f of files) handleImportBrush(f);
          }}
          className="flex-1 overflow-y-auto px-1.5 py-0.5 space-y-1 relative min-h-[84px]"
        >
          {isDraggingFileOver && (
            <div className="absolute inset-1 bg-[#161616]/95 rounded flex flex-col items-center justify-center p-2 text-center z-30 pointer-events-none">
              <FolderDown className="w-4 h-4 text-[var(--accent)] mb-1" />
              <span className="text-[10px] text-[#e5e5e5]">Drop .inkb / .sut</span>
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
                      <div
                        key={item.id}
                        onClick={() => handleSelectBrushPreset(item.id)}
                        title={`${item.name} - ${item.desc}`}
                        className={`group w-full flex items-center gap-1.5 px-2 py-1 rounded text-left transition-colors cursor-pointer ${
                          isSelected
                            ? 'bg-[#2c2c2c] text-[#e5e5e5] font-medium'
                            : 'text-[#8a8a8a] hover:text-[#e5e5e5] hover:bg-[#2c2c2c]/60'
                        }`}
                      >
                        {renderBuiltinIcon(item.icon)}
                        <span className="text-[11px] truncate leading-tight flex-1">
                          {item.name}
                        </span>
                        <button
                          type="button"
                          onClick={(e) => handleExportBrush(item.id, e)}
                          title={`Export ${item.name} (.inkb)`}
                          className="opacity-0 group-hover:opacity-100 text-[#8a8a8a] hover:text-[#e5e5e5] shrink-0 cursor-pointer"
                        >
                          <Download className="w-2.5 h-2.5" />
                        </button>
                      </div>
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
                          <Paintbrush className="w-3 h-3 shrink-0 opacity-70" />
                        )}
                        <span className="text-[11px] truncate leading-tight">{brush.name}</span>
                        {brush.importWarnings && brush.importWarnings.length > 0 && (
                          <span
                            title={brush.importWarnings.join('\n')}
                            className="text-amber-400 shrink-0"
                            aria-label="Import warning"
                          >
                            <AlertTriangle className="w-2.5 h-2.5" />
                          </span>
                        )}
                      </div>
                      <div className="flex items-center gap-1 shrink-0">
                        <button
                          type="button"
                          onClick={(e) => handleExportBrush(brush.id, e)}
                          title={`Export ${brush.name} (.inkb)`}
                          className="opacity-0 group-hover:opacity-100 text-[#8a8a8a] hover:text-[#e5e5e5] shrink-0 cursor-pointer"
                        >
                          <Download className="w-2.5 h-2.5" />
                        </button>
                        <button
                          type="button"
                          onClick={(e) => void handleDeleteCustomBrush(e, brush)}
                          title="Delete brush"
                          className="opacity-0 group-hover:opacity-100 text-[#8a8a8a] hover:text-red-400 shrink-0 cursor-pointer"
                        >
                          <Trash2 className="w-2.5 h-2.5" />
                        </button>
                      </div>
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
