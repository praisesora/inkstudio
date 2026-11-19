import { useMemo } from 'react';
import {
  FilePlus,
  FolderOpen,
  Save,
  Download,
  Trash2,
  Film,
  Layers,
  Undo2,
  Redo2,
  ZoomIn,
  ZoomOut,
  RotateCcw,
  FlipHorizontal,
  FlipVertical,
  Plus,
  Info as InfoIcon,
  Copy,
  ClipboardPaste,
  ImagePlus,
  Scaling,
  Settings,
  FolderDown,
  PaintBucket,
  SlidersHorizontal,
  Compass,
  Eye,
  EyeOff,
  Magnet,
  Lock,
  Unlock,
  Box,
  Maximize2,
  Minimize2,
  Feather,
  BoxSelect,
  X,
  Smartphone,
  Archive,
  Sparkles,
  MessageSquare,
  Spline,
} from 'lucide-react';
import {
  AnimationTimeline,
  CanvasDimensions,
  CanvasSelection,
  CmykStandard,
  ExpressionColor,
  FilterType,
  LayerItem,
  MenuSection,
  SoftProofSettings,
} from '../types/editor';
import { PerspectiveRuler } from '../types/perspective';
import { createDefaultAnimationTimeline } from '../utils/animationEngine';
import { createDefaultPerspectiveRuler, applyWormsEyePreset } from '../utils/perspectiveMath';
import { parseSutFile } from '../utils/sutParser';
import {
  deleteCustomBrush,
  loadCustomBrushes,
  prepareBrushSettingsForCsp,
  saveCustomBrush,
} from '../utils/brushStorage';
import { TonalCorrectionType } from '../utils/tonalEngine';
import { AnyFilterParams } from './useTonalAndFilterActions';
import {
  documentStoreActions,
  toolStoreActions,
  uiStoreActions,
  useWorkspaceStore,
  workspaceStoreActions,
} from '../stores';
import {
  ALL_DOCK_PANEL_IDS,
  DOCK_PANEL_META,
  WORKSPACE_PRESET_LABELS,
  WorkspacePresetId,
} from '../types/workspace';
import { listVisiblePanelIds } from '../utils/workspacePresets';

export interface UseAppMenuSectionsParams {
  hasOpenDocument: boolean;
  dimensions: CanvasDimensions;
  layers: LayerItem[];
  activeLayer: LayerItem | undefined;
  activeLayerId: string;
  selection: CanvasSelection | null;
  canUndo: boolean;
  canRedo: boolean;
  flipX: boolean;
  flipY: boolean;
  isWebtoonMode: boolean;
  perspectiveRuler: PerspectiveRuler | null;
  softProofSettings: SoftProofSettings;
  activeAnimationTimeline: AnimationTimeline | null;
  clearCanvas: () => void;
  handleUndo: () => void;
  redo: () => void;
  handleTriggerOpenFile: () => void;
  handleTriggerImport3DFile: () => void;
  handleSave: () => void;
  handleSaveAs: () => void;
  handleExportImage: () => void;
  handleCopySelectedLayer: () => void;
  handlePasteSelectedLayer: () => void;
  handleTriggerPasteFromFile: () => void;
  handleDeleteSelectedLayer: () => void;
  handleClearActiveLayer: () => void;
  handleStartTransform: () => void;
  handleDeselect: () => void;
  handleFillSelectionColor: () => void;
  handleOpenTonalModal: (type: TonalCorrectionType) => void;
  handleApplyReverseGradient: () => void;
  handleSelectAll: () => void;
  handleInvertSelection: () => void;
  handleExpandSelection: (pixels?: number) => void;
  handleContractSelection: (pixels?: number) => void;
  handleFeatherSelection: (radius?: number) => void;
  handleAddLayer: (type?: 'raster' | 'folder') => void;
  handleOpenAdjustmentModal: (
    layerId?: string,
    initialType?: 'curves' | 'gradient-map' | 'levels' | 'color-balance'
  ) => void;
  addLayerMask: (layerId: string) => void;
  removeLayerMask: (layerId: string) => void;
  toggleLayerMask: (layerId: string) => void;
  toggleMaskLinked: (layerId: string) => void;
  duplicateLayer: (layerId: string) => void;
  handleMergeDown: () => void;
  handleOpenLayerStylesModal: (layerId?: string) => void;
  toggleLayerColor: (layerId: string) => void;
  handleConvertLayer: (layerId: string, mode: ExpressionColor) => void;
  deleteLayer: (layerId: string) => void;
  handleApplyFilter: (type: FilterType, params?: AnyFilterParams) => void;
  zoomIn: () => void;
  zoomOut: () => void;
  resetZoomAndCenter: () => void;
  resetRotation: () => void;
  toggleFlipHorizontal: () => void;
  toggleFlipVertical: () => void;
  resetViewFlip: () => void;
  handleUpdateAnimationTimeline: (timeline: AnimationTimeline | null) => void;
  handleAddAnimationCel: (frameIndex: number) => void;
  showToast: (msg: string) => void;
}

export function useAppMenuSections(params: UseAppMenuSectionsParams): MenuSection[] {
  const {
    hasOpenDocument,
    dimensions,
    layers,
    activeLayer,
    activeLayerId,
    selection,
    canUndo,
    canRedo,
    flipX,
    flipY,
    isWebtoonMode,
    perspectiveRuler,
    softProofSettings,
    activeAnimationTimeline,
    clearCanvas,
    handleUndo,
    redo,
    handleTriggerOpenFile,
    handleTriggerImport3DFile,
    handleSave,
    handleSaveAs,
    handleExportImage,
    handleCopySelectedLayer,
    handlePasteSelectedLayer,
    handleTriggerPasteFromFile,
    handleDeleteSelectedLayer,
    handleClearActiveLayer,
    handleStartTransform,
    handleDeselect,
    handleFillSelectionColor,
    handleOpenTonalModal,
    handleApplyReverseGradient,
    handleSelectAll,
    handleInvertSelection,
    handleExpandSelection,
    handleContractSelection,
    handleFeatherSelection,
    handleAddLayer,
    handleOpenAdjustmentModal,
    addLayerMask,
    removeLayerMask,
    toggleLayerMask,
    toggleMaskLinked,
    duplicateLayer,
    handleMergeDown,
    handleOpenLayerStylesModal,
    toggleLayerColor,
    handleConvertLayer,
    deleteLayer,
    handleApplyFilter,
    zoomIn,
    zoomOut,
    resetZoomAndCenter,
    resetRotation,
    toggleFlipHorizontal,
    toggleFlipVertical,
    resetViewFlip,
    handleUpdateAnimationTimeline,
    handleAddAnimationCel,
    showToast,
  } = params;

  const activePreset = useWorkspaceStore((s) => s.activePreset);
  const workspaceLayout = useWorkspaceStore((s) => s.layout);
  const palettesHidden = useWorkspaceStore((s) => s.palettesHidden);
  const showStatusBar = useWorkspaceStore((s) => s.showStatusBar);
  const showDocumentTabs = useWorkspaceStore((s) => s.showDocumentTabs);
  const showCommandBar = useWorkspaceStore((s) => s.showCommandBar);
  const visiblePanels = useMemo(() => listVisiblePanelIds(workspaceLayout), [workspaceLayout]);

  return useMemo(
    () => [
      {
        id: 'file',
        label: 'File',
        items: [
          {
            id: 'file-new',
            label: 'New...',
            shortcut: 'Ctrl+N',
            icon: <FilePlus className="w-3.5 h-3.5 text-sky-400" />,
            onClick: () => uiStoreActions.setNewCanvasModalOpen(true),
          },
          {
            id: 'file-open',
            label: 'Open...',
            shortcut: 'Ctrl+O',
            icon: <FolderOpen className="w-3.5 h-3.5 text-amber-400" />,
            onClick: handleTriggerOpenFile,
          },
          {
            id: 'file-import-sut',
            label: 'Import CSP Brush (.sut)...',
            icon: <FolderDown className="w-3.5 h-3.5 text-cyan-400" />,
            onClick: () => {
              const input = document.createElement('input');
              input.type = 'file';
              input.accept = '.sut';
              input.onchange = async () => {
                const file = input.files?.[0];
                if (file) {
                  try {
                    uiStoreActions.setLoading(true, `Importing CSP Brush: ${file.name}...`);
                    const buffer = await file.arrayBuffer();
                    const parsedBrush = await parseSutFile(buffer, file.name);
                    const existing = (await loadCustomBrushes()).filter(
                      (b) =>
                        b.name.toLowerCase() === parsedBrush.name.toLowerCase() ||
                        b.id === parsedBrush.id
                    );
                    for (const old of existing) {
                      await deleteCustomBrush(old.id).catch(() => {});
                    }
                    await saveCustomBrush(parsedBrush);
                    toolStoreActions.setToolRaw('brush');
                    const fullSettings = await prepareBrushSettingsForCsp(parsedBrush);
                    toolStoreActions.updateBrushSettings(fullSettings);
                    showToast(`Imported CSP brush "${parsedBrush.name}" successfully!`);
                  } catch (err: unknown) {
                    const msg =
                      err instanceof Error ? err.message : 'Failed to import .sut brush.';
                    showToast(msg);
                  } finally {
                    uiStoreActions.setLoading(false, '');
                  }
                }
              };
              input.click();
            },
          },
          {
            id: 'file-import-3d',
            label: 'Import 3D Model (.glb, .obj)...',
            icon: <Box className="w-3.5 h-3.5 text-purple-400" />,
            disabled: !hasOpenDocument,
            onClick: handleTriggerImport3DFile,
          },
          { id: 'file-div-1', label: '', divider: true },
          {
            id: 'file-save',
            label: 'Save',
            shortcut: 'Ctrl+S',
            icon: <Save className="w-3.5 h-3.5 text-blue-400" />,
            disabled: !hasOpenDocument,
            onClick: handleSave,
          },
          {
            id: 'file-save-as',
            label: 'Save As...',
            shortcut: 'Ctrl+Shift+S',
            icon: <Save className="w-3.5 h-3.5 text-indigo-400" />,
            disabled: !hasOpenDocument,
            onClick: handleSaveAs,
          },
          {
            id: 'file-export-image',
            label: 'Export Image...',
            icon: <Download className="w-3.5 h-3.5 text-emerald-400" />,
            disabled: !hasOpenDocument,
            onClick: handleExportImage,
          },
          {
            id: 'file-export-webtoon',
            label: 'Export Webtoon Chapter Slices (.zip)...',
            icon: <Archive className="w-3.5 h-3.5 text-cyan-400" />,
            disabled: !hasOpenDocument,
            onClick: () => uiStoreActions.setWebtoonExportModalOpen(true),
          },
          { id: 'file-div-2', label: '', divider: true },
          {
            id: 'file-clear',
            label: 'Clear Canvas',
            icon: <Trash2 className="w-3.5 h-3.5 text-rose-400" />,
            danger: true,
            disabled: !hasOpenDocument,
            onClick: clearCanvas,
          },
        ],
      },
      {
        id: 'edit',
        label: 'Edit',
        items: [
          {
            id: 'edit-undo',
            label: 'Undo',
            shortcut: 'Ctrl+Z',
            icon: <Undo2 className="w-3.5 h-3.5" />,
            disabled: !hasOpenDocument || !canUndo,
            onClick: handleUndo,
          },
          {
            id: 'edit-redo',
            label: 'Redo',
            shortcut: 'Ctrl+Y',
            icon: <Redo2 className="w-3.5 h-3.5" />,
            disabled: !hasOpenDocument || !canRedo,
            onClick: redo,
          },
          { id: 'edit-div-1', label: '', divider: true },
          {
            id: 'edit-copy',
            label: 'Copy',
            shortcut: 'Ctrl+C',
            icon: <Copy className="w-3.5 h-3.5 text-sky-400" />,
            disabled: !hasOpenDocument || !activeLayer,
            onClick: handleCopySelectedLayer,
          },
          {
            id: 'edit-paste',
            label: 'Paste',
            shortcut: 'Ctrl+V',
            icon: <ClipboardPaste className="w-3.5 h-3.5 text-amber-400" />,
            disabled: !hasOpenDocument,
            onClick: handlePasteSelectedLayer,
          },
          {
            id: 'edit-paste-file',
            label: 'Paste from file...',
            icon: <ImagePlus className="w-3.5 h-3.5 text-emerald-400" />,
            disabled: !hasOpenDocument,
            onClick: handleTriggerPasteFromFile,
          },
          {
            id: 'edit-import-3d',
            label: 'Import 3D File (.glb, .obj)...',
            icon: <Box className="w-3.5 h-3.5 text-purple-400" />,
            disabled: !hasOpenDocument,
            onClick: handleTriggerImport3DFile,
          },
          {
            id: 'edit-delete',
            label: 'Delete',
            shortcut: 'Del',
            icon: <Trash2 className="w-3.5 h-3.5 text-rose-400" />,
            danger: true,
            disabled: !hasOpenDocument || layers.filter((l) => l.type === 'raster').length <= 1,
            onClick: handleDeleteSelectedLayer,
          },
          {
            id: 'edit-clear-layer',
            label: 'Clear Active Layer',
            disabled: !hasOpenDocument || !activeLayer,
            onClick: handleClearActiveLayer,
          },
          {
            id: 'edit-transform',
            label: 'Free Transform',
            shortcut: 'Ctrl+T',
            icon: <Scaling className="w-3.5 h-3.5 text-cyan-400" />,
            disabled: !hasOpenDocument,
            onClick: handleStartTransform,
          },
          {
            id: 'edit-deselect',
            label: 'Deselect',
            shortcut: 'Ctrl+D',
            disabled: !hasOpenDocument || !selection,
            onClick: handleDeselect,
          },
          {
            id: 'edit-fill-sel',
            label: 'Fill Selection',
            icon: <PaintBucket className="w-3.5 h-3.5 text-amber-400" />,
            disabled: !hasOpenDocument || !selection,
            onClick: handleFillSelectionColor,
          },
          {
            id: 'edit-tonal-correction',
            label: 'Tonal Correction',
            icon: <SlidersHorizontal className="w-3.5 h-3.5 text-violet-400" />,
            disabled:
              !hasOpenDocument || !activeLayer || activeLayer.locked || activeLayer.type !== 'raster',
            submenu: [
              {
                id: 'edit-tonal-brightness-contrast',
                label: 'Brightness/Contrast...',
                disabled:
                  !hasOpenDocument ||
                  !activeLayer ||
                  activeLayer.locked ||
                  activeLayer.type !== 'raster',
                onClick: () => handleOpenTonalModal('brightness-contrast'),
              },
              {
                id: 'edit-tonal-hue-saturation',
                label: 'Hue/Saturation/Luminosity...',
                shortcut: 'Ctrl+U',
                disabled:
                  !hasOpenDocument ||
                  !activeLayer ||
                  activeLayer.locked ||
                  activeLayer.type !== 'raster',
                onClick: () => handleOpenTonalModal('hue-saturation'),
              },
              {
                id: 'edit-tonal-posterization',
                label: 'Posterization...',
                disabled:
                  !hasOpenDocument ||
                  !activeLayer ||
                  activeLayer.locked ||
                  activeLayer.type !== 'raster',
                onClick: () => handleOpenTonalModal('posterization'),
              },
              {
                id: 'edit-tonal-reverse-gradient',
                label: 'Reverse Gradient',
                shortcut: 'Ctrl+I',
                disabled:
                  !hasOpenDocument ||
                  !activeLayer ||
                  activeLayer.locked ||
                  activeLayer.type !== 'raster',
                onClick: handleApplyReverseGradient,
              },
              {
                id: 'edit-tonal-level-correction',
                label: 'Level Correction...',
                disabled:
                  !hasOpenDocument ||
                  !activeLayer ||
                  activeLayer.locked ||
                  activeLayer.type !== 'raster',
                onClick: () => handleOpenTonalModal('level-correction'),
              },
              {
                id: 'edit-tonal-binarization',
                label: 'Binarization...',
                disabled:
                  !hasOpenDocument ||
                  !activeLayer ||
                  activeLayer.locked ||
                  activeLayer.type !== 'raster',
                onClick: () => handleOpenTonalModal('binarization'),
              },
            ],
          },
          { id: 'edit-div-2', label: '', divider: true },
          {
            id: 'edit-resize-canvas',
            label: 'Resize Canvas...',
            icon: <Scaling className="w-3.5 h-3.5 text-indigo-400" />,
            disabled: !hasOpenDocument,
            onClick: () => uiStoreActions.setResizeCanvasModalOpen(true),
          },
          { id: 'edit-div-3', label: '', divider: true },
          {
            id: 'edit-settings',
            label: 'Settings...',
            shortcut: 'Ctrl+,',
            icon: <Settings className="w-3.5 h-3.5 text-slate-300" />,
            onClick: () => uiStoreActions.setSettingsModalOpen(true),
          },
        ],
      },
      {
        id: 'select',
        label: 'Select',
        items: [
          {
            id: 'select-all',
            label: 'Select All',
            shortcut: 'Ctrl+A',
            icon: <BoxSelect className="w-3.5 h-3.5 text-sky-400" />,
            disabled: !hasOpenDocument,
            onClick: handleSelectAll,
          },
          {
            id: 'select-deselect',
            label: 'Deselect',
            shortcut: 'Ctrl+D',
            icon: <X className="w-3.5 h-3.5 text-rose-400" />,
            disabled: !hasOpenDocument || !selection,
            onClick: handleDeselect,
          },
          {
            id: 'select-invert',
            label: 'Invert Selection',
            shortcut: 'Ctrl+Shift+I',
            icon: <RotateCcw className="w-3.5 h-3.5 text-amber-400" />,
            disabled: !hasOpenDocument,
            onClick: handleInvertSelection,
          },
          { id: 'select-div-1', label: '', divider: true },
          {
            id: 'select-expand',
            label: 'Expand (+5px)...',
            icon: <Maximize2 className="w-3.5 h-3.5 text-indigo-400" />,
            disabled: !hasOpenDocument || !selection,
            onClick: () => handleExpandSelection(5),
          },
          {
            id: 'select-contract',
            label: 'Contract (-5px)...',
            icon: <Minimize2 className="w-3.5 h-3.5 text-emerald-400" />,
            disabled: !hasOpenDocument || !selection,
            onClick: () => handleContractSelection(5),
          },
          {
            id: 'select-feather',
            label: 'Feather (5px)...',
            icon: <Feather className="w-3.5 h-3.5 text-purple-400" />,
            disabled: !hasOpenDocument || !selection,
            onClick: () => handleFeatherSelection(5),
          },
          { id: 'select-div-2', label: '', divider: true },
          {
            id: 'select-transform',
            label: 'Transform Selection',
            shortcut: 'Ctrl+T',
            icon: <Scaling className="w-3.5 h-3.5 text-cyan-400" />,
            disabled: !hasOpenDocument || !selection,
            onClick: handleStartTransform,
          },
        ],
      },
      {
        id: 'layer',
        label: 'Layer',
        items: [
          {
            id: 'layer-new-raster',
            label: 'New Raster Layer',
            shortcut: 'Ctrl+Shift+N',
            icon: <Plus className="w-3.5 h-3.5" />,
            disabled: !hasOpenDocument,
            onClick: () => handleAddLayer('raster'),
          },
          {
            id: 'layer-new-folder',
            label: 'New Folder',
            disabled: !hasOpenDocument,
            onClick: () => handleAddLayer('folder'),
          },
          {
            id: 'layer-new-3d',
            label: 'New 3D Reference Layer...',
            icon: <Box className="w-3.5 h-3.5 text-purple-400" />,
            disabled: !hasOpenDocument,
            onClick: () => uiStoreActions.set3DLayerOpen(true),
          },
          {
            id: 'layer-new-adjustment',
            label: 'New Adjustment Layer',
            disabled: !hasOpenDocument,
            submenu: [
              {
                id: 'layer-adj-curves',
                label: 'Tone Curves...',
                onClick: () => handleOpenAdjustmentModal(undefined, 'curves'),
              },
              {
                id: 'layer-adj-gradient-map',
                label: 'Gradient Map...',
                onClick: () => handleOpenAdjustmentModal(undefined, 'gradient-map'),
              },
              {
                id: 'layer-adj-levels',
                label: 'Levels...',
                onClick: () => handleOpenAdjustmentModal(undefined, 'levels'),
              },
              {
                id: 'layer-adj-color-balance',
                label: 'Color Balance...',
                onClick: () => handleOpenAdjustmentModal(undefined, 'color-balance'),
              },
            ],
          },
          {
            id: 'layer-mask-submenu',
            label: 'Layer Mask',
            disabled: !hasOpenDocument || !activeLayer || activeLayer.type === 'folder',
            submenu: [
              {
                id: 'layer-mask-add',
                label: activeLayer?.maskCanvas
                  ? 'Mask Already Present'
                  : 'Add Layer Mask (Reveal All)',
                disabled: Boolean(activeLayer?.maskCanvas),
                onClick: () => addLayerMask(activeLayerId),
              },
              {
                id: 'layer-mask-delete',
                label: 'Delete Layer Mask',
                danger: true,
                disabled: !activeLayer?.maskCanvas,
                onClick: () => removeLayerMask(activeLayerId),
              },
              {
                id: 'layer-mask-toggle',
                label:
                  activeLayer?.maskEnabled === false ? 'Enable Layer Mask' : 'Disable Layer Mask',
                disabled: !activeLayer?.maskCanvas,
                onClick: () => toggleLayerMask(activeLayerId),
              },
              {
                id: 'layer-mask-link',
                label:
                  activeLayer?.maskLinked === false
                    ? 'Link Mask to Layer'
                    : 'Unlink Mask from Layer',
                disabled: !activeLayer?.maskCanvas,
                onClick: () => toggleMaskLinked(activeLayerId),
              },
            ],
          },
          {
            id: 'layer-duplicate',
            label: 'Duplicate Layer',
            shortcut: 'Ctrl+J',
            disabled: !hasOpenDocument || !activeLayer,
            onClick: () => duplicateLayer(activeLayerId),
          },
          {
            id: 'layer-merge-down',
            label: 'Merge with Layer Below',
            disabled: !hasOpenDocument || !activeLayer || activeLayer.type !== 'raster' || layers.length <= 1,
            onClick: handleMergeDown,
          },
          { id: 'layer-div-effects', label: '', divider: true },
          {
            id: 'layer-styles',
            label: 'Layer Style (Stroke, Shadow, Glow)...',
            disabled:
              !hasOpenDocument ||
              !activeLayer ||
              activeLayer.type === 'folder' ||
              activeLayer.type === 'adjustment',
            onClick: () => handleOpenLayerStylesModal(activeLayerId),
          },
          {
            id: 'layer-toggle-tint',
            label: activeLayer?.layerColorEnabled
              ? 'Disable Layer Color (Tint)'
              : 'Enable Layer Color (Tint)',
            disabled: !hasOpenDocument || !activeLayer || activeLayer.type === 'folder',
            onClick: () => toggleLayerColor(activeLayerId),
          },
          {
            id: 'layer-convert-submenu',
            label: 'Convert Expression Color',
            disabled: !hasOpenDocument || !activeLayer || activeLayer.type === 'folder',
            submenu: [
              {
                id: 'layer-convert-color',
                label: 'Color (RGB)',
                onClick: () => handleConvertLayer(activeLayerId, 'color'),
              },
              {
                id: 'layer-convert-gray',
                label: 'Gray (Grayscale)',
                onClick: () => handleConvertLayer(activeLayerId, 'gray'),
              },
              {
                id: 'layer-convert-monochrome',
                label: 'Monochrome (1-bit B&W)',
                onClick: () => handleConvertLayer(activeLayerId, 'monochrome'),
              },
            ],
          },
          { id: 'layer-div-ruler', label: '', divider: true },
          {
            id: 'layer-perspective-ruler',
            label: 'Perspective Ruler',
            disabled: !hasOpenDocument,
            submenu: !perspectiveRuler
              ? [
                  {
                    id: 'layer-add-ruler-1p',
                    label: 'Add 1-Point Perspective Ruler',
                    onClick: () => {
                      documentStoreActions.setPerspectiveRuler(
                        createDefaultPerspectiveRuler('1-point', dimensions)
                      );
                      showToast('1-Point Perspective Ruler added to canvas');
                    },
                  },
                  {
                    id: 'layer-add-ruler-2p',
                    label: 'Add 2-Point Perspective Ruler',
                    onClick: () => {
                      documentStoreActions.setPerspectiveRuler(
                        createDefaultPerspectiveRuler('2-point', dimensions)
                      );
                      showToast('2-Point Perspective Ruler added to canvas');
                    },
                  },
                  {
                    id: 'layer-add-ruler-3p-birds',
                    label: "Add 3-Point Perspective Ruler (Bird's-Eye)",
                    onClick: () => {
                      documentStoreActions.setPerspectiveRuler(
                        createDefaultPerspectiveRuler('3-point', dimensions)
                      );
                      showToast("3-Point Perspective Ruler (Bird's-Eye) added to canvas");
                    },
                  },
                  {
                    id: 'layer-add-ruler-3p-worms',
                    label: "Add 3-Point Perspective Ruler (Worm's-Eye)",
                    onClick: () => {
                      const base = createDefaultPerspectiveRuler('3-point', dimensions);
                      documentStoreActions.setPerspectiveRuler(
                        applyWormsEyePreset(base, dimensions)
                      );
                      showToast("3-Point Perspective Ruler (Worm's-Eye) added to canvas");
                    },
                  },
                ]
              : [
                  {
                    id: 'layer-remove-ruler',
                    label: 'Remove Perspective Ruler from Canvas',
                    danger: true,
                    onClick: () => {
                      documentStoreActions.setPerspectiveRuler(null);
                      showToast('Removed perspective ruler from canvas');
                    },
                  },
                ],
          },
          { id: 'layer-div-delete', label: '', divider: true },
          {
            id: 'layer-delete',
            label: 'Delete Layer',
            danger: true,
            disabled: !hasOpenDocument || layers.length <= 1,
            onClick: () => deleteLayer(activeLayerId),
          },
        ],
      },
      {
        id: 'filter',
        label: 'Filter',
        items: [
          {
            id: 'filter-gaussian-blur',
            label: 'Gaussian Blur...',
            disabled:
              !hasOpenDocument || !activeLayer || activeLayer.type !== 'raster' || activeLayer.locked,
            onClick: () => {
              const r = window.prompt('Gaussian Blur Radius (px, 1-100):', '5');
              if (r !== null) {
                const radius = Math.max(1, Math.min(100, parseFloat(r) || 5));
                handleApplyFilter('gaussian-blur', { radius });
              }
            },
          },
          {
            id: 'filter-motion-blur',
            label: 'Motion Blur...',
            disabled:
              !hasOpenDocument || !activeLayer || activeLayer.type !== 'raster' || activeLayer.locked,
            onClick: () => {
              const d = window.prompt('Motion Blur Distance (px, 1-100):', '15');
              const a =
                d !== null ? window.prompt('Motion Blur Angle (degrees, 0-360):', '0') : null;
              if (d !== null && a !== null) {
                const distance = Math.max(1, Math.min(100, parseFloat(d) || 15));
                const angle = Math.max(0, Math.min(360, parseFloat(a) || 0));
                handleApplyFilter('motion-blur', { distance, angle });
              }
            },
          },
          {
            id: 'filter-unsharp-mask',
            label: 'Unsharp Mask...',
            disabled:
              !hasOpenDocument || !activeLayer || activeLayer.type !== 'raster' || activeLayer.locked,
            onClick: () => {
              const r = window.prompt('Unsharp Mask Radius (px, 0.5-20):', '2');
              const a = r !== null ? window.prompt('Amount factor (0.1-5.0):', '1.5') : null;
              if (r !== null && a !== null) {
                const radius = Math.max(0.5, Math.min(20, parseFloat(r) || 2));
                const amount = Math.max(0.1, Math.min(5, parseFloat(a) || 1.5));
                handleApplyFilter('unsharp-mask', { radius, amount, threshold: 0 });
              }
            },
          },
          {
            id: 'filter-film-grain',
            label: 'Film Grain...',
            disabled:
              !hasOpenDocument || !activeLayer || activeLayer.type !== 'raster' || activeLayer.locked,
            onClick: () => {
              const i = window.prompt('Film Grain Intensity (% 1-100):', '25');
              if (i !== null) {
                const intensity = Math.max(1, Math.min(100, parseFloat(i) || 25));
                handleApplyFilter('film-grain', { intensity, size: 1, monochromatic: true });
              }
            },
          },
        ],
      },
      {
        id: 'ruler',
        label: 'Ruler',
        items: !perspectiveRuler
          ? [
              {
                id: 'ruler-add-1p',
                label: 'Add 1-Point Perspective Ruler',
                icon: <Compass className="w-3.5 h-3.5 text-cyan-400" />,
                disabled: !hasOpenDocument,
                onClick: () => {
                  documentStoreActions.setPerspectiveRuler(
                    createDefaultPerspectiveRuler('1-point', dimensions)
                  );
                  showToast('1-Point Perspective Ruler added to canvas');
                },
              },
              {
                id: 'ruler-add-2p',
                label: 'Add 2-Point Perspective Ruler',
                icon: <Compass className="w-3.5 h-3.5 text-purple-400" />,
                disabled: !hasOpenDocument,
                onClick: () => {
                  documentStoreActions.setPerspectiveRuler(
                    createDefaultPerspectiveRuler('2-point', dimensions)
                  );
                  showToast('2-Point Perspective Ruler added to canvas');
                },
              },
              {
                id: 'ruler-add-3p-birds',
                label: "Add 3-Point Perspective Ruler (Bird's-Eye)",
                icon: <Compass className="w-3.5 h-3.5 text-emerald-400" />,
                disabled: !hasOpenDocument,
                onClick: () => {
                  documentStoreActions.setPerspectiveRuler(
                    createDefaultPerspectiveRuler('3-point', dimensions)
                  );
                  showToast("3-Point Perspective Ruler (Bird's-Eye) added to canvas");
                },
              },
              {
                id: 'ruler-add-3p-worms',
                label: "Add 3-Point Perspective Ruler (Worm's-Eye)",
                icon: <Compass className="w-3.5 h-3.5 text-amber-400" />,
                disabled: !hasOpenDocument,
                onClick: () => {
                  const base = createDefaultPerspectiveRuler('3-point', dimensions);
                  documentStoreActions.setPerspectiveRuler(
                    applyWormsEyePreset(base, dimensions)
                  );
                  showToast("3-Point Perspective Ruler (Worm's-Eye) added to canvas");
                },
              },
            ]
          : [
              {
                id: 'ruler-toggle-visibility',
                label: perspectiveRuler.enabled
                  ? 'Hide Perspective Ruler'
                  : 'Show Perspective Ruler',
                shortcut: 'Ctrl+Shift+R',
                icon: perspectiveRuler.enabled ? (
                  <EyeOff className="w-3.5 h-3.5 text-sky-400" />
                ) : (
                  <Eye className="w-3.5 h-3.5 text-sky-400" />
                ),
                disabled: !hasOpenDocument,
                onClick: () =>
                  documentStoreActions.setPerspectiveRuler((prev) =>
                    prev ? { ...prev, enabled: !prev.enabled } : null
                  ),
              },
              {
                id: 'ruler-toggle-snap',
                label: perspectiveRuler.snapEnabled ? 'Disable Snapping' : 'Enable Snapping',
                shortcut: 'Ctrl+Shift+P',
                icon: <Magnet className="w-3.5 h-3.5 text-emerald-400" />,
                disabled: !hasOpenDocument,
                onClick: () =>
                  documentStoreActions.setPerspectiveRuler((prev) =>
                    prev ? { ...prev, snapEnabled: !prev.snapEnabled } : null
                  ),
              },
              {
                id: 'ruler-toggle-lock',
                label: perspectiveRuler.locked
                  ? 'Unlock Handles (Edit Mode)'
                  : 'Lock Handles (Freeze for Inking)',
                icon: perspectiveRuler.locked ? (
                  <Unlock className="w-3.5 h-3.5 text-amber-400" />
                ) : (
                  <Lock className="w-3.5 h-3.5 text-amber-400" />
                ),
                disabled: !hasOpenDocument,
                onClick: () =>
                  documentStoreActions.setPerspectiveRuler((prev) =>
                    prev ? { ...prev, locked: !prev.locked } : null
                  ),
              },
              {
                id: 'ruler-line-count',
                label: `Guide Rays (${perspectiveRuler.guideRayCount || 6} lines)`,
                disabled: !hasOpenDocument,
                submenu: [2, 4, 6, 8, 12, 16].map((count) => ({
                  id: `ruler-rays-${count}`,
                  label: `${count} Rays per VP`,
                  checked: (perspectiveRuler.guideRayCount || 6) === count,
                  onClick: () =>
                    documentStoreActions.setPerspectiveRuler((prev) =>
                      prev ? { ...prev, guideRayCount: count } : null
                    ),
                })),
              },
              {
                id: 'ruler-presets',
                label: 'Change Perspective Preset',
                disabled: !hasOpenDocument,
                submenu: [
                  {
                    id: 'ruler-preset-1p',
                    label: '1-Point Perspective (Center)',
                    onClick: () => {
                      const next = createDefaultPerspectiveRuler('1-point', dimensions);
                      next.snapEnabled = perspectiveRuler.snapEnabled;
                      next.locked = perspectiveRuler.locked;
                      next.guideRayCount = perspectiveRuler.guideRayCount;
                      documentStoreActions.setPerspectiveRuler(next);
                    },
                  },
                  {
                    id: 'ruler-preset-2p',
                    label: '2-Point Perspective (Wide Street)',
                    onClick: () => {
                      const next = createDefaultPerspectiveRuler('2-point', dimensions);
                      next.snapEnabled = perspectiveRuler.snapEnabled;
                      next.locked = perspectiveRuler.locked;
                      next.guideRayCount = perspectiveRuler.guideRayCount;
                      documentStoreActions.setPerspectiveRuler(next);
                    },
                  },
                  {
                    id: 'ruler-preset-3p-birds',
                    label: "3-Point Perspective (Bird's-Eye)",
                    onClick: () => {
                      const next = createDefaultPerspectiveRuler('3-point', dimensions);
                      next.snapEnabled = perspectiveRuler.snapEnabled;
                      next.locked = perspectiveRuler.locked;
                      next.guideRayCount = perspectiveRuler.guideRayCount;
                      documentStoreActions.setPerspectiveRuler(next);
                    },
                  },
                  {
                    id: 'ruler-preset-3p-worms',
                    label: "3-Point Perspective (Worm's-Eye)",
                    onClick: () => {
                      const base = createDefaultPerspectiveRuler('3-point', dimensions);
                      base.guideRayCount = perspectiveRuler.guideRayCount;
                      documentStoreActions.setPerspectiveRuler(
                        applyWormsEyePreset(base, dimensions)
                      );
                    },
                  },
                ],
              },
              { id: 'ruler-div-remove', label: '', divider: true },
              {
                id: 'ruler-remove',
                label: 'Remove Perspective Ruler from Canvas',
                danger: true,
                icon: <Trash2 className="w-3.5 h-3.5 text-red-400" />,
                disabled: !hasOpenDocument,
                onClick: () => {
                  documentStoreActions.setPerspectiveRuler(null);
                  showToast('Removed perspective ruler from canvas');
                },
              },
            ],
      },
      {
        id: 'view',
        label: 'View',
        items: [
          {
            id: 'view-zoom-in',
            label: 'Zoom In',
            shortcut: 'Ctrl++',
            icon: <ZoomIn className="w-3.5 h-3.5" />,
            disabled: !hasOpenDocument,
            onClick: zoomIn,
          },
          {
            id: 'view-zoom-out',
            label: 'Zoom Out',
            shortcut: 'Ctrl+-',
            icon: <ZoomOut className="w-3.5 h-3.5" />,
            disabled: !hasOpenDocument,
            onClick: zoomOut,
          },
          {
            id: 'view-reset-zoom',
            label: 'Reset Zoom & Center',
            shortcut: 'Ctrl+0',
            disabled: !hasOpenDocument,
            onClick: resetZoomAndCenter,
          },
          {
            id: 'view-reset-rotation',
            label: 'Reset Rotation',
            shortcut: 'Ctrl+Alt+0',
            icon: <RotateCcw className="w-3.5 h-3.5" />,
            disabled: !hasOpenDocument,
            onClick: resetRotation,
          },
          { id: 'view-div-flip', label: '', divider: true },
          {
            id: 'view-flip-horizontal',
            label: 'Flip View Horizontal',
            shortcut: 'Shift+H',
            icon: <FlipHorizontal className="w-3.5 h-3.5" />,
            checked: flipX,
            disabled: !hasOpenDocument,
            onClick: toggleFlipHorizontal,
          },
          {
            id: 'view-flip-vertical',
            label: 'Flip View Vertical',
            shortcut: 'Shift+V',
            icon: <FlipVertical className="w-3.5 h-3.5" />,
            checked: flipY,
            disabled: !hasOpenDocument,
            onClick: toggleFlipVertical,
          },
          {
            id: 'view-reset-flip',
            label: 'Reset View Flip',
            disabled: !hasOpenDocument || (!flipX && !flipY),
            onClick: resetViewFlip,
          },
          { id: 'view-div-ruler', label: '', divider: true },
          {
            id: 'view-toggle-ruler',
            label: perspectiveRuler?.enabled
              ? 'Hide Perspective Ruler'
              : 'Show Perspective Ruler',
            shortcut: 'Ctrl+Shift+R',
            disabled: !hasOpenDocument || !perspectiveRuler,
            onClick: () =>
              documentStoreActions.setPerspectiveRuler((prev) =>
                prev ? { ...prev, enabled: !prev.enabled } : null
              ),
          },
          {
            id: 'view-toggle-snap',
            label: perspectiveRuler?.snapEnabled
              ? 'Disable Perspective Snapping'
              : 'Enable Perspective Snapping',
            shortcut: 'Ctrl+Shift+P',
            disabled: !hasOpenDocument || !perspectiveRuler,
            onClick: () =>
              documentStoreActions.setPerspectiveRuler((prev) =>
                prev ? { ...prev, snapEnabled: !prev.snapEnabled } : null
              ),
          },
          { id: 'view-div-webtoon', label: '', divider: true },
          {
            id: 'view-webtoon-mode',
            label: isWebtoonMode
              ? 'Exit Webtoon Studio Mode'
              : 'Webtoon Studio Mode (9:16 Mockup)',
            icon: <Smartphone className="w-3.5 h-3.5 text-emerald-400" />,
            disabled: !hasOpenDocument,
            onClick: () => uiStoreActions.toggleWebtoonMode(),
          },
          { id: 'view-div-soft-proof', label: '', divider: true },
          {
            id: 'view-proof-setup',
            label: 'Proof Setup',
            disabled: !hasOpenDocument,
            submenu: (
              [
                {
                  id: 'proof-setup-us-web',
                  label: 'Working CMYK - U.S. Web Coated (SWOP) v2',
                  standard: 'us-web-coated-swop' as CmykStandard,
                },
                {
                  id: 'proof-setup-japan',
                  label: 'Japan Color 2001 Coated',
                  standard: 'japan-color-2001' as CmykStandard,
                },
                {
                  id: 'proof-setup-iso',
                  label: 'ISO Coated v2 (ECI)',
                  standard: 'iso-coated-v2' as CmykStandard,
                },
              ] as const
            ).map((opt) => ({
              id: opt.id,
              label: opt.label,
              checked: softProofSettings.standard === opt.standard,
              onClick: () => documentStoreActions.setProofStandard(opt.standard),
            })),
          },
          {
            id: 'view-proof-colors',
            label: 'Proof Colors',
            shortcut: 'Ctrl+Alt+Y',
            checked: softProofSettings.enabled,
            disabled: !hasOpenDocument,
            onClick: () => documentStoreActions.toggleSoftProof(),
          },
          {
            id: 'view-gamut-warning',
            label: 'Gamut Warning',
            shortcut: 'Ctrl+Shift+Y',
            checked: softProofSettings.gamutWarning,
            disabled: !hasOpenDocument,
            onClick: () => documentStoreActions.toggleGamutWarning(),
          },
        ],
      },
      {
        id: 'manga',
        label: 'Manga',
        items: [
          {
            id: 'manga-effects-generator',
            label: 'Manga Effect Lines Generator...',
            icon: <Sparkles className="w-3.5 h-3.5 text-amber-400" />,
            disabled: !hasOpenDocument,
            onClick: () => uiStoreActions.setMangaEffectsModalOpen(true),
          },
          {
            id: 'manga-balloon-tool',
            label: 'Parametric Speech Balloon Tool',
            icon: <MessageSquare className="w-3.5 h-3.5 text-cyan-400" />,
            disabled: !hasOpenDocument,
            onClick: () => toolStoreActions.selectTool('balloon'),
          },
          {
            id: 'manga-correct-line',
            label: 'Correct Line (Vector Pinch/Width/Simplify)',
            icon: <Spline className="w-3.5 h-3.5 text-indigo-400" />,
            disabled: !hasOpenDocument,
            onClick: () => toolStoreActions.selectTool('vector-edit'),
          },
          { id: 'manga-div-webtoon', label: '', divider: true },
          {
            id: 'manga-webtoon-toggle',
            label: isWebtoonMode
              ? 'Exit Webtoon Studio Mode'
              : 'Webtoon Studio Mode (9:16 Simulator)',
            icon: <Smartphone className="w-3.5 h-3.5 text-emerald-400" />,
            disabled: !hasOpenDocument,
            onClick: () => uiStoreActions.toggleWebtoonMode(),
          },
          {
            id: 'manga-webtoon-export',
            label: 'Export Webtoon Chapter Slices (.zip)...',
            icon: <Archive className="w-3.5 h-3.5 text-sky-400" />,
            disabled: !hasOpenDocument,
            onClick: () => uiStoreActions.setWebtoonExportModalOpen(true),
          },
        ],
      },
      {
        id: 'animation',
        label: 'Animation',
        items: [
          {
            id: 'anim-toggle-timeline',
            label: activeAnimationTimeline
              ? 'Hide Animation Timeline'
              : 'Show Animation Timeline',
            shortcut: 'Ctrl+Alt+A',
            icon: <Film className="w-3.5 h-3.5 text-emerald-400" />,
            disabled: !hasOpenDocument,
            onClick: () => {
              if (activeAnimationTimeline) {
                handleUpdateAnimationTimeline(null);
              } else {
                handleUpdateAnimationTimeline(createDefaultAnimationTimeline(layers));
              }
            },
          },
          {
            id: 'anim-new-cel',
            label: 'Add Cel to Current Frame',
            shortcut: 'Alt+C',
            icon: <Plus className="w-3.5 h-3.5" />,
            disabled: !hasOpenDocument || !activeAnimationTimeline,
            onClick: () => {
              if (activeAnimationTimeline) {
                handleAddAnimationCel(activeAnimationTimeline.currentFrame);
              }
            },
          },
          {
            id: 'anim-toggle-onion',
            label: activeAnimationTimeline?.onionSkin.enabled
              ? 'Disable Onion Skinning'
              : 'Enable Onion Skinning',
            icon: <Layers className="w-3.5 h-3.5 text-purple-400" />,
            disabled: !hasOpenDocument || !activeAnimationTimeline,
            onClick: () => {
              if (activeAnimationTimeline) {
                handleUpdateAnimationTimeline({
                  ...activeAnimationTimeline,
                  onionSkin: {
                    ...activeAnimationTimeline.onionSkin,
                    enabled: !activeAnimationTimeline.onionSkin.enabled,
                  },
                });
              }
            },
          },
        ],
      },
      {
        id: 'window',
        label: 'Window',
        items: [
          {
            id: 'window-workspace',
            label: 'Workspace',
            submenu: [
              ...(
                ['default-illustration', 'manga-studio', 'minimalist-tablet', 'custom'] as WorkspacePresetId[]
              ).map((preset) => ({
                id: `window-preset-${preset}`,
                label: WORKSPACE_PRESET_LABELS[preset],
                checked: activePreset === preset,
                onClick: () => workspaceStoreActions.applyPreset(preset),
              })),
              { id: 'window-ws-div-1', label: '', divider: true },
              {
                id: 'window-ws-save-custom',
                label: 'Register Current Layout as Custom',
                onClick: () => {
                  workspaceStoreActions.saveAsCustomPreset();
                  showToast('Workspace saved to Custom preset');
                },
              },
              {
                id: 'window-ws-reset',
                label: 'Reset Workspace',
                icon: <RotateCcw className="w-3.5 h-3.5 text-amber-400" />,
                onClick: () => {
                  workspaceStoreActions.resetWorkspace();
                  showToast('Workspace reset to preset defaults');
                },
              },
            ],
          },
          {
            id: 'window-toggle-palettes',
            label: palettesHidden ? 'Show Palettes' : 'Hide Palettes',
            shortcut: 'Tab',
            checked: !palettesHidden,
            onClick: () => workspaceStoreActions.togglePalettesHidden(),
          },
          { id: 'window-div-palettes', label: '', divider: true },
          ...ALL_DOCK_PANEL_IDS.map((pid) => ({
            id: `window-panel-${pid}`,
            label: DOCK_PANEL_META[pid].title,
            checked: visiblePanels.has(pid),
            onClick: () => workspaceStoreActions.togglePanelVisibility(pid),
          })),
          { id: 'window-div-bars', label: '', divider: true },
          {
            id: 'window-toggle-command-bar',
            label: 'Command Bar',
            checked: showCommandBar,
            onClick: () => workspaceStoreActions.setShowCommandBar(!showCommandBar),
          },
          {
            id: 'window-toggle-doc-tabs',
            label: 'Document Tab Bar',
            checked: showDocumentTabs,
            onClick: () => workspaceStoreActions.setShowDocumentTabs(!showDocumentTabs),
          },
          {
            id: 'window-toggle-status-bar',
            label: 'Status Bar',
            checked: showStatusBar,
            onClick: () => workspaceStoreActions.setShowStatusBar(!showStatusBar),
          },
        ],
      },
      {
        id: 'help',
        label: 'Help',
        items: [
          {
            id: 'help-about',
            label: 'About Ink Studio',
            icon: <InfoIcon className="w-3.5 h-3.5 text-[#93c5fd]" />,
            onClick: () => {
              alert(
                'Ink Studio - Professional Digital Painting & Manga Studio\n\n' +
                  '- Full Layer Management with 17 Blend Modes\n' +
                  '- Supports Opening PSD (Photoshop) & CSP (Clip Studio Paint) with layers\n' +
                  '- Supports Common Images: PNG, JPG, WEBP, GIF, BMP, SVG\n' +
                  '- Save & Save As: PSD (layered), Ink Studio Project (.sora / .ink), PNG, JPG, WebP\n' +
                  '- Export Image: High-resolution PNG\n' +
                  '- Color Modes: Full Color (RGB), Grayscale, and 1-bit Manga Monochrome\n' +
                  '- CSP Sub-Tool Engine, Tablet Pressure, Tilt & Inking Stabilization'
              );
            },
          },
        ],
      },
    ],
    [
      activeAnimationTimeline,
      activeLayer,
      activeLayerId,
      activePreset,
      addLayerMask,
      canRedo,
      canUndo,
      clearCanvas,
      deleteLayer,
      dimensions,
      duplicateLayer,
      flipX,
      flipY,
      handleAddAnimationCel,
      handleAddLayer,
      handleApplyFilter,
      handleApplyReverseGradient,
      handleClearActiveLayer,
      handleContractSelection,
      handleConvertLayer,
      handleCopySelectedLayer,
      handleDeleteSelectedLayer,
      handleDeselect,
      handleExpandSelection,
      handleExportImage,
      handleFeatherSelection,
      handleFillSelectionColor,
      handleInvertSelection,
      handleMergeDown,
      handleOpenAdjustmentModal,
      handleOpenLayerStylesModal,
      handleOpenTonalModal,
      handlePasteSelectedLayer,
      handleSave,
      handleSaveAs,
      handleSelectAll,
      handleStartTransform,
      handleTriggerImport3DFile,
      handleTriggerOpenFile,
      handleTriggerPasteFromFile,
      handleUndo,
      handleUpdateAnimationTimeline,
      hasOpenDocument,
      isWebtoonMode,
      layers,
      palettesHidden,
      perspectiveRuler,
      redo,
      removeLayerMask,
      resetRotation,
      resetViewFlip,
      resetZoomAndCenter,
      selection,
      showCommandBar,
      showDocumentTabs,
      showStatusBar,
      showToast,
      softProofSettings.enabled,
      softProofSettings.gamutWarning,
      softProofSettings.standard,
      toggleFlipHorizontal,
      toggleFlipVertical,
      toggleLayerColor,
      toggleLayerMask,
      toggleMaskLinked,
      visiblePanels,
      zoomIn,
      zoomOut,
    ]
  );
}
