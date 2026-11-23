import React, { useCallback } from 'react';
import {
  AdjustmentLayerData,
  CanvasColorMode,
  CanvasDimensions,
  CanvasSelection,
  ExpressionColor,
  FilterType,
  LayerItem,
  LayerStyles,
  LayerTreeDelta,
  TileDelta,
} from '../types/editor';
import { documentStore } from '../utils/documentStore';
import {
  TileFormat,
  TileSnapshotEntry,
  releaseTemporaryCanvas,
} from '../utils/tileEngine';
import {
  applyFilterToTileGridAsync,
  FilmGrainParams,
  GaussianBlurParams,
  MotionBlurParams,
  UnsharpMaskParams,
} from '../utils/filterEngine';
import { HalftoneDotShape } from '../utils/screentoneEngine';
import { get2DContext } from '../utils/canvasUtils';
import {
  TonalCorrectionType,
  BrightnessContrastParams,
  BinarizationParams,
  HueSaturationParams,
  PosterizationParams,
  LevelCorrectionParams,
  applyTonalToTileGrid,
  computeHistogramsFromTileSnapshot,
  createSelectionMask,
  getProcessingBounds,
} from '../utils/tonalEngine';

export type AnyFilterParams =
  | GaussianBlurParams
  | MotionBlurParams
  | UnsharpMaskParams
  | FilmGrainParams;

export type AnyTonalParams =
  | BrightnessContrastParams
  | BinarizationParams
  | HueSaturationParams
  | PosterizationParams
  | LevelCorrectionParams
  | Record<string, never>;
import {
  renderSaturatedLines,
  renderStreamLines,
  SaturatedLinesOptions,
  StreamLinesOptions,
} from '../utils/mangaEffectsEngine';
import { SimpleToneSettings } from '../components/SimpleToneModal';
import { useUiStore, uiStoreActions } from '../stores';
import { PushHistoryStepFn } from './drawing';

export interface UseTonalAndFilterActionsParams {
  hasOpenDocument: boolean;
  dimensions: CanvasDimensions;
  colorMode: CanvasColorMode;
  layers: LayerItem[];
  activeLayer: LayerItem | undefined;
  activeLayerId: string;
  selection: CanvasSelection | null;
  setActiveLayerId: (id: string) => void;
  updateLayerThumbnail: (layerId: string, immediate?: boolean) => void;
  handleCommitFloatingSelection: () => void;
  pushHistoryStepRef: React.MutableRefObject<PushHistoryStepFn | null>;
  addLayer: (
    type?: 'raster' | 'folder' | 'vector',
    parentId?: string | null,
    customName?: string,
    customId?: string
  ) => LayerItem;
  pasteLayerFromCanvas: (
    canvas: HTMLCanvasElement,
    name?: string,
    blendMode?: LayerItem['blendMode'],
    opacity?: number,
    customId?: string,
    extraProps?: Partial<LayerItem>
  ) => void;
  addAdjustmentLayer: (
    type: 'curves' | 'gradient-map' | 'levels' | 'color-balance',
    data: AdjustmentLayerData
  ) => void;
  updateAdjustmentData: (layerId: string, data: AdjustmentLayerData) => void;
  updateLayerStyles: (layerId: string, styles: LayerStyles) => void;
  fillScreentoneSelection: (
    selection: CanvasSelection | null,
    density: number,
    frequency: number,
    angle: number,
    dotShape: HalftoneDotShape,
    densityType: 'specified' | 'image'
  ) => { id: string; tileDeltas: TileDelta[]; layerTreeDelta?: LayerTreeDelta };
  applyExpressionColorOfPreview: (
    layerId: string
  ) => { tileDeltas: TileDelta[] } | null | undefined;
  applyLayerColorPermanently: (
    layerId: string
  ) => { tileDeltas: TileDelta[]; layerTreeDelta?: LayerTreeDelta } | null | undefined;
  convertLayer: (
    layerId: string,
    targetMode: ExpressionColor,
    options?: { threshold?: number; expressBlack?: boolean; expressWhite?: boolean }
  ) => { tileDeltas: TileDelta[]; layerTreeDelta?: LayerTreeDelta } | null | undefined;
  showToast: (msg: string) => void;
}

export function useTonalAndFilterActions({
  hasOpenDocument,
  dimensions,
  colorMode,
  layers,
  activeLayer,
  activeLayerId,
  selection,
  setActiveLayerId,
  updateLayerThumbnail,
  handleCommitFloatingSelection,
  pushHistoryStepRef,
  addLayer,
  pasteLayerFromCanvas,
  addAdjustmentLayer,
  updateAdjustmentData,
  updateLayerStyles,
  fillScreentoneSelection,
  applyExpressionColorOfPreview,
  applyLayerColorPermanently,
  convertLayer,
  showToast,
}: UseTonalAndFilterActionsParams) {
  const resolveTargetFormat = useCallback(
    (layerId: string, layer?: LayerItem): TileFormat => {
      const isBg = layerId === 'layer-bg' || layerId.startsWith('layer-bg');
      if (isBg) return 'color-32bit';
      const l = layer ?? layers.find((item) => item.id === layerId);
      if (colorMode === 'monochrome' || l?.expressionColor === 'monochrome') {
        return 'monochrome-1bit';
      }
      return 'color-32bit';
    },
    [colorMode, layers]
  );

  const handleOpenAdjustmentModal = useCallback(
    (
      layerId?: string,
      initialType: 'curves' | 'gradient-map' | 'levels' | 'color-balance' = 'curves'
    ) => {
      uiStoreActions.setAdjustmentModalState({
        isOpen: true,
        layerId: layerId || undefined,
        initialType,
      });
    },
    []
  );

  const handleApplyAdjustment = useCallback(
    (type: 'curves' | 'gradient-map' | 'levels' | 'color-balance', data: AdjustmentLayerData) => {
      const targetId = useUiStore.getState().adjustmentModalState.layerId;
      if (targetId) {
        updateAdjustmentData(targetId, data);
        showToast(`Updated ${data.type} adjustment layer`);
      } else {
        addAdjustmentLayer(type, data);
        showToast(`Created new ${data.type} adjustment layer`);
      }
      uiStoreActions.setAdjustmentModalState({ isOpen: false });
    },
    [updateAdjustmentData, addAdjustmentLayer, showToast]
  );

  const handleOpenLayerStylesModal = useCallback(
    (layerId?: string) => {
      const targetId = layerId || activeLayerId;
      if (targetId) {
        uiStoreActions.setLayerStylesModalState({
          isOpen: true,
          layerId: targetId,
        });
      }
    },
    [activeLayerId]
  );

  const handleApplyLayerStyles = useCallback(
    (styles: LayerStyles) => {
      const targetId = useUiStore.getState().layerStylesModalState.layerId;
      if (targetId) {
        updateLayerStyles(targetId, styles);
        showToast('Updated Layer Styles');
      }
      uiStoreActions.setLayerStylesModalState({ isOpen: false });
    },
    [updateLayerStyles, showToast]
  );

  const handleApplyFilter = useCallback(
    (type: FilterType, params?: AnyFilterParams) => {
      if (
        !hasOpenDocument ||
        !activeLayer ||
        activeLayer.type !== 'raster' ||
        activeLayer.locked
      ) {
        showToast('Select an unlocked raster layer to apply filter');
        return;
      }
      if (dimensions.width <= 0 || dimensions.height <= 0) return;

      const grid = documentStore.getActiveTileGrid();
      const targetFormat = resolveTargetFormat(activeLayerId, activeLayer);
      const targetLayerId = activeLayerId;

      void applyFilterToTileGridAsync({
        grid,
        layerId: targetLayerId,
        dimensions,
        type,
        filterParams: params,
        targetFormat,
        selection,
      }).then(({ dirtyRect, tileDeltas }) => {
        if (tileDeltas.length > 0) {
          pushHistoryStepRef.current?.(
            'filter',
            `Filter: ${type.replace('-', ' ')}`,
            null,
            null,
            targetLayerId,
            dirtyRect ?? undefined,
            tileDeltas
          );
        }
        updateLayerThumbnail(targetLayerId, true);
        showToast(`Filter applied: ${type.replace('-', ' ')}`);
      });
    },
    [
      hasOpenDocument,
      activeLayer,
      activeLayerId,
      selection,
      dimensions,
      resolveTargetFormat,
      pushHistoryStepRef,
      updateLayerThumbnail,
      showToast,
    ]
  );

  const getTonalLabel = useCallback((type: TonalCorrectionType) => {
    switch (type) {
      case 'brightness-contrast':
        return 'Brightness/Contrast';
      case 'binarization':
        return 'Binarization';
      case 'hue-saturation':
        return 'Hue/Saturation/Luminosity';
      case 'posterization':
        return 'Posterization';
      case 'level-correction':
        return 'Level Correction';
      case 'reverse-gradient':
        return 'Reverse Gradient';
      default:
        return 'Tonal Correction';
    }
  }, []);

  const handleOpenTonalModal = useCallback(
    (type: TonalCorrectionType) => {
      if (
        !hasOpenDocument ||
        !activeLayer ||
        activeLayer.locked ||
        activeLayer.type !== 'raster'
      ) {
        return;
      }
      if (selection?.floating) {
        handleCommitFloatingSelection();
      }

      const grid = documentStore.getActiveTileGrid();
      let targetLayerId = activeLayerId;
      const hasPixels = grid.hasLayerTiles(targetLayerId);

      if (!hasPixels) {
        const candidate = layers.find(
          (l) =>
            l.id !== targetLayerId &&
            l.type === 'raster' &&
            l.visible &&
            grid.hasLayerTiles(l.id)
        );
        if (candidate) {
          targetLayerId = candidate.id;
          setActiveLayerId(candidate.id);
          showToast(`Switched to "${candidate.name}" (active layer had no pixels)`);
        } else {
          showToast('Selected layer is empty. Draw or open an image first.');
          return;
        }
      }

      const beforeTileSnapshot = grid.snapshotLayerTiles(targetLayerId);
      const selectionMask = createSelectionMask(selection, dimensions.width, dimensions.height);
      const bounds = getProcessingBounds(selection, dimensions.width, dimensions.height);
      const histograms =
        type === 'level-correction'
          ? computeHistogramsFromTileSnapshot(beforeTileSnapshot, dimensions, selectionMask)
          : null;

      uiStoreActions.setTonalModalState({
        isOpen: true,
        type,
        targetLayerId,
        beforeTileSnapshot,
        histograms,
        selectionMask,
        bounds,
      });
    },
    [
      hasOpenDocument,
      activeLayer,
      activeLayerId,
      layers,
      dimensions,
      selection,
      handleCommitFloatingSelection,
      setActiveLayerId,
      showToast,
    ]
  );

  const handleTonalPreviewChange = useCallback(
    (type: TonalCorrectionType, params: AnyTonalParams, enabled: boolean) => {
      const state = useUiStore.getState().tonalModalState;
      if (!state.isOpen || !state.beforeTileSnapshot) return;
      const grid = documentStore.getActiveTileGrid();
      const targetLayerId = state.targetLayerId;

      if (enabled) {
        applyTonalToTileGrid({
          grid,
          layerId: targetLayerId,
          dimensions,
          beforeSnapshot: state.beforeTileSnapshot,
          type,
          tonalParams: params,
          targetFormat: resolveTargetFormat(targetLayerId),
          selectionMask: state.selectionMask,
          bounds: state.bounds,
        });
      } else {
        grid.restoreLayerSnapshot(targetLayerId, state.beforeTileSnapshot, false);
      }
    },
    [dimensions, resolveTargetFormat]
  );

  const handleTonalApply = useCallback(
    (type: TonalCorrectionType, params: AnyTonalParams) => {
      const state = useUiStore.getState().tonalModalState;
      if (!state.isOpen || !state.beforeTileSnapshot) return;
      const grid = documentStore.getActiveTileGrid();
      const targetLayerId = state.targetLayerId;

      const { tileDeltas } = applyTonalToTileGrid({
        grid,
        layerId: targetLayerId,
        dimensions,
        beforeSnapshot: state.beforeTileSnapshot,
        type,
        tonalParams: params,
        targetFormat: resolveTargetFormat(targetLayerId),
        selectionMask: state.selectionMask,
        bounds: state.bounds,
      });

      const label = getTonalLabel(type);
      if (tileDeltas.length > 0) {
        pushHistoryStepRef.current?.(
          'tonal-correction',
          label,
          null,
          null,
          targetLayerId,
          undefined,
          tileDeltas
        );
      }
      updateLayerThumbnail(targetLayerId, true);

      uiStoreActions.setTonalModalState({
        isOpen: false,
        type,
        targetLayerId: '',
        beforeTileSnapshot: null,
        histograms: null,
        selectionMask: null,
        bounds: { x0: 0, y0: 0, x1: 0, y1: 0 },
      });
      showToast(`Applied ${label}`);
    },
    [
      dimensions,
      resolveTargetFormat,
      updateLayerThumbnail,
      getTonalLabel,
      pushHistoryStepRef,
      showToast,
    ]
  );

  const handleTonalCancel = useCallback(() => {
    const state = useUiStore.getState().tonalModalState;
    if (!state.isOpen) return;
    if (state.beforeTileSnapshot && state.targetLayerId) {
      documentStore
        .getActiveTileGrid()
        .restoreLayerSnapshot(state.targetLayerId, state.beforeTileSnapshot, false);
    }

    uiStoreActions.setTonalModalState({
      isOpen: false,
      type: state.type,
      targetLayerId: '',
      beforeTileSnapshot: null,
      histograms: null,
      selectionMask: null,
      bounds: { x0: 0, y0: 0, x1: 0, y1: 0 },
    });
  }, []);

  const handleApplyReverseGradient = useCallback(() => {
    if (
      !hasOpenDocument ||
      !activeLayer ||
      activeLayer.locked ||
      activeLayer.type !== 'raster'
    ) {
      return;
    }
    if (selection?.floating) {
      handleCommitFloatingSelection();
    }

    const grid = documentStore.getActiveTileGrid();
    let targetLayerId = activeLayerId;

    if (!grid.hasLayerTiles(targetLayerId)) {
      const candidate = layers.find(
        (l) =>
          l.id !== targetLayerId &&
          l.type === 'raster' &&
          l.visible &&
          grid.hasLayerTiles(l.id)
      );
      if (candidate) {
        targetLayerId = candidate.id;
        setActiveLayerId(candidate.id);
        showToast(`Switched to "${candidate.name}" (active layer had no pixels)`);
      } else {
        showToast('Selected layer is empty. Draw or open an image first.');
        return;
      }
    }

    const beforeSnapshot = grid.snapshotLayerTiles(targetLayerId);
    const mask = createSelectionMask(selection, dimensions.width, dimensions.height);
    const bounds = getProcessingBounds(selection, dimensions.width, dimensions.height);

    const { tileDeltas } = applyTonalToTileGrid({
      grid,
      layerId: targetLayerId,
      dimensions,
      beforeSnapshot,
      type: 'reverse-gradient',
      tonalParams: {},
      targetFormat: resolveTargetFormat(targetLayerId),
      selectionMask: mask,
      bounds,
    });

    if (tileDeltas.length > 0) {
      pushHistoryStepRef.current?.(
        'tonal-correction',
        'Reverse Gradient',
        null,
        null,
        targetLayerId,
        undefined,
        tileDeltas
      );
    }
    updateLayerThumbnail(targetLayerId, true);
    showToast('Inverted colors (Reverse Gradient)');
  }, [
    hasOpenDocument,
    activeLayer,
    activeLayerId,
    layers,
    dimensions,
    selection,
    handleCommitFloatingSelection,
    resolveTargetFormat,
    updateLayerThumbnail,
    pushHistoryStepRef,
    setActiveLayerId,
    showToast,
  ]);

  const handleApplyMangaEffects = useCallback(
    (type: 'saturated' | 'stream', options: SaturatedLinesOptions | StreamLinesOptions) => {
      if (!activeLayerId || activeLayer?.locked || dimensions.width <= 0 || dimensions.height <= 0) {
        return;
      }

      const grid = documentStore.getActiveTileGrid();
      const targetFormat = resolveTargetFormat(activeLayerId, activeLayer);
      const beforeSnapshot = new Map<string, TileSnapshotEntry>();
      const CHUNK = 1024;
      const chunkCanvas = document.createElement('canvas');
      chunkCanvas.width = Math.min(CHUNK, dimensions.width);
      chunkCanvas.height = Math.min(CHUNK, dimensions.height);
      const cCtx = get2DContext(chunkCanvas);
      if (!cCtx) {
        releaseTemporaryCanvas(chunkCanvas);
        return;
      }

      try {
        for (let cy = 0; cy < dimensions.height; cy += CHUNK) {
          const ch = Math.min(CHUNK, dimensions.height - cy);
          for (let cx = 0; cx < dimensions.width; cx += CHUNK) {
            const cw = Math.min(CHUNK, dimensions.width - cx);
            if (chunkCanvas.width !== cw) chunkCanvas.width = cw;
            if (chunkCanvas.height !== ch) chunkCanvas.height = ch;

            cCtx.setTransform(1, 0, 0, 1, 0, 0);
            cCtx.clearRect(0, 0, cw, ch);
            cCtx.save();
            cCtx.translate(-cx, -cy);
            if (type === 'saturated') {
              renderSaturatedLines(
                cCtx,
                dimensions.width,
                dimensions.height,
                options as SaturatedLinesOptions
              );
            } else {
              renderStreamLines(
                cCtx,
                dimensions.width,
                dimensions.height,
                options as StreamLinesOptions
              );
            }
            cCtx.restore();

            const img = cCtx.getImageData(0, 0, cw, ch);
            grid.compositeStrokeToTiles({
              layerId: activeLayerId,
              strokeData: img,
              destX: cx,
              destY: cy,
              format: targetFormat,
              compositeOp: 'source-over',
              opacity: 1.0,
              snapshotOut: beforeSnapshot,
              suppressNotify: true,
            });
          }
        }
      } finally {
        releaseTemporaryCanvas(chunkCanvas);
      }

      const tileDeltas = grid.computeDeltasFromSnapshot(beforeSnapshot, activeLayerId);
      grid.notifyChange(true);
      updateLayerThumbnail(activeLayerId, true);
      if (tileDeltas.length > 0) {
        pushHistoryStepRef.current?.(
          'brush',
          `Manga Effect (${type})`,
          null,
          null,
          activeLayerId,
          undefined,
          tileDeltas
        );
      }
      showToast(`Applied manga ${type} lines`);
    },
    [
      activeLayerId,
      activeLayer,
      dimensions.width,
      dimensions.height,
      resolveTargetFormat,
      updateLayerThumbnail,
      pushHistoryStepRef,
      showToast,
    ]
  );

  const handleInsert3DRasterLayer = useCallback(
    (layer: LayerItem, canvas: HTMLCanvasElement) => {
      if (layer.type === 'folder') {
        addLayer('folder', layer.parentId, layer.name, layer.id);
      } else {
        pasteLayerFromCanvas(canvas, layer.name, layer.blendMode, layer.opacity, layer.id, layer);
      }
      showToast(`Added 3D layer "${layer.name}".`);
    },
    [addLayer, pasteLayerFromCanvas, showToast]
  );

  const handleFillScreentone = useCallback(() => {
    uiStoreActions.setToneModalOpen(true);
  }, []);

  const handleConfirmTone = useCallback(
    (settings: SimpleToneSettings) => {
      uiStoreActions.setToneModalOpen(false);
      if (selection?.floating) {
        handleCommitFloatingSelection();
      }
      const { id, tileDeltas, layerTreeDelta } = fillScreentoneSelection(
        selection,
        settings.density,
        settings.frequency,
        settings.angle,
        settings.dotShape,
        settings.densityType
      );
      if (tileDeltas.length > 0 || layerTreeDelta) {
        pushHistoryStepRef.current?.(
          'screentone',
          `Screentone (${settings.density}%)`,
          null,
          null,
          id,
          selection?.bounds,
          tileDeltas,
          undefined,
          undefined,
          undefined,
          false,
          layerTreeDelta
        );
      }
      showToast(`Created Screentone Layer (${settings.density}%)`);
    },
    [selection, handleCommitFloatingSelection, fillScreentoneSelection, pushHistoryStepRef, showToast]
  );

  const handleApplyExpressionColor = useCallback(
    (layerId: string) => {
      const result = applyExpressionColorOfPreview(layerId);
      if (result && result.tileDeltas.length > 0) {
        pushHistoryStepRef.current?.(
          'expression-color',
          'Apply Expression Color',
          null,
          null,
          layerId,
          undefined,
          result.tileDeltas
        );
        showToast('Applied expression color to layer');
      }
    },
    [applyExpressionColorOfPreview, pushHistoryStepRef, showToast]
  );

  const handleApplyLayerColor = useCallback(
    (layerId: string) => {
      const result = applyLayerColorPermanently(layerId);
      if (result && (result.tileDeltas.length > 0 || result.layerTreeDelta)) {
        pushHistoryStepRef.current?.(
          'layer-color',
          'Apply Layer Color Tint',
          null,
          null,
          layerId,
          undefined,
          result.tileDeltas,
          undefined,
          undefined,
          undefined,
          false,
          result.layerTreeDelta
        );
        showToast('Applied tint to layer permanently');
      }
    },
    [applyLayerColorPermanently, pushHistoryStepRef, showToast]
  );

  const handleConvertLayer = useCallback(
    (
      layerId: string,
      targetMode: ExpressionColor,
      options?: { threshold?: number; expressBlack?: boolean; expressWhite?: boolean }
    ) => {
      const result = convertLayer(layerId, targetMode, options);
      if (result && (result.tileDeltas.length > 0 || result.layerTreeDelta)) {
        pushHistoryStepRef.current?.(
          'layer-convert',
          `Convert to ${targetMode.toUpperCase()}`,
          null,
          null,
          layerId,
          undefined,
          result.tileDeltas,
          undefined,
          undefined,
          undefined,
          false,
          result.layerTreeDelta
        );
        showToast(`Converted layer to ${targetMode}`);
      }
    },
    [convertLayer, pushHistoryStepRef, showToast]
  );

  return {
    handleOpenAdjustmentModal,
    handleApplyAdjustment,
    handleOpenLayerStylesModal,
    handleApplyLayerStyles,
    handleApplyFilter,
    handleOpenTonalModal,
    handleTonalPreviewChange,
    handleTonalApply,
    handleTonalCancel,
    handleApplyReverseGradient,
    handleApplyMangaEffects,
    handleInsert3DRasterLayer,
    handleFillScreentone,
    handleConfirmTone,
    handleApplyExpressionColor,
    handleApplyLayerColor,
    handleConvertLayer,
  };
}
