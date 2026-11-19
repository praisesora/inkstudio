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
} from '../types/editor';
import { documentStore } from '../utils/documentStore';
import {
  applyFilter,
  FilmGrainParams,
  GaussianBlurParams,
  MotionBlurParams,
  UnsharpMaskParams,
} from '../utils/filterEngine';
import { applyScreentone, HalftoneDotShape } from '../utils/screentoneEngine';
import { applyLayerEffects } from '../utils/layerEffectsEngine';
import { get2DContext } from '../utils/canvasUtils';
import {
  TonalCorrectionType,
  BrightnessContrastParams,
  BinarizationParams,
  HueSaturationParams,
  PosterizationParams,
  LevelCorrectionParams,
  applyTonalFilter,
  applyReverseGradient,
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
  layerCanvasesRef: React.MutableRefObject<Map<string, HTMLCanvasElement>>;
  layerSourceCanvasesRef: React.MutableRefObject<Map<string, HTMLCanvasElement>>;
  materializeLayerCanvas: (layerId: string) => HTMLCanvasElement | null;
  releaseLayerCanvas: (layerId: string) => void;
  setActiveLayerId: (id: string) => void;
  getActiveCanvas: () => HTMLCanvasElement | null;
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
  ) => { id: string; canvas: HTMLCanvasElement };
  applyExpressionColorOfPreview: (
    layerId: string
  ) => { beforeImageData: ImageData | null; afterImageData: ImageData | null } | null | undefined;
  applyLayerColorPermanently: (
    layerId: string
  ) => { beforeImageData: ImageData | null; afterImageData: ImageData | null } | null | undefined;
  convertLayer: (
    layerId: string,
    targetMode: ExpressionColor,
    options?: { threshold?: number; expressBlack?: boolean; expressWhite?: boolean }
  ) => { beforeImageData: ImageData | null; afterImageData: ImageData | null } | null | undefined;
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
  layerCanvasesRef,
  layerSourceCanvasesRef,
  materializeLayerCanvas,
  releaseLayerCanvas,
  setActiveLayerId,
  getActiveCanvas,
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
      const grid = documentStore.getActiveTileGrid();
      const isTone = Boolean(
        activeLayer.toneEnabled && layerSourceCanvasesRef.current?.get(activeLayerId)
      );
      const sourceCanvas = layerSourceCanvasesRef.current?.get(activeLayerId);
      const displayCanvas = layerCanvasesRef.current.get(activeLayerId);

      const width = dimensions.width;
      const height = dimensions.height;
      if (width <= 0 || height <= 0) return;

      let beforeImageData: ImageData;
      if (isTone && sourceCanvas) {
        const sCtx = get2DContext(sourceCanvas);
        if (!sCtx) return;
        beforeImageData = sCtx.getImageData(0, 0, sourceCanvas.width, sourceCanvas.height);
      } else {
        const raw = grid.readImageData(activeLayerId, 0, 0, width, height);
        beforeImageData = new ImageData(new Uint8ClampedArray(raw.data), width, height);
      }

      const rawFiltered = applyFilter(
        new ImageData(
          new Uint8ClampedArray(beforeImageData.data),
          beforeImageData.width,
          beforeImageData.height
        ),
        type,
        params
      );

      let finalImageData = rawFiltered;
      if (selection) {
        const selMask = createSelectionMask(selection, width, height);
        if (selMask) {
          finalImageData = new ImageData(new Uint8ClampedArray(beforeImageData.data), width, height);
          const src = beforeImageData.data;
          const flt = rawFiltered.data;
          const dst = finalImageData.data;
          for (let i = 0; i < selMask.length; i++) {
            const m = selMask[i];
            if (m === 0) continue;
            const p = i * 4;
            if (m === 255) {
              dst[p] = flt[p];
              dst[p + 1] = flt[p + 1];
              dst[p + 2] = flt[p + 2];
              dst[p + 3] = flt[p + 3];
            } else {
              const a = m / 255;
              const inv = 1 - a;
              dst[p] = Math.round(src[p] * inv + flt[p] * a);
              dst[p + 1] = Math.round(src[p + 1] * inv + flt[p + 1] * a);
              dst[p + 2] = Math.round(src[p + 2] * inv + flt[p + 2] * a);
              dst[p + 3] = Math.round(src[p + 3] * inv + flt[p + 3] * a);
            }
          }
        }
      }

      const isMono = colorMode === 'monochrome' || activeLayer.expressionColor === 'monochrome';
      const targetFormat = isMono ? 'monochrome-1bit' : 'color-32bit';

      if (isTone && sourceCanvas) {
        get2DContext(sourceCanvas)?.putImageData(finalImageData, 0, 0);
        const effDisplay = displayCanvas || materializeLayerCanvas(activeLayerId);
        if (effDisplay) {
          applyLayerEffects(sourceCanvas, effDisplay, activeLayer, dimensions.dpi ?? 600);
          grid.ingestCanvas(activeLayerId, effDisplay, targetFormat);
        }
      } else {
        grid.writeImageData(activeLayerId, finalImageData, 0, 0, targetFormat);
        if (displayCanvas) {
          get2DContext(displayCanvas)?.putImageData(finalImageData, 0, 0);
          releaseLayerCanvas(activeLayerId);
        }
        if (sourceCanvas) {
          get2DContext(sourceCanvas)?.putImageData(finalImageData, 0, 0);
        }
      }

      pushHistoryStepRef.current?.(
        'filter',
        `Filter: ${type.replace('-', ' ')}`,
        beforeImageData,
        finalImageData,
        activeLayerId
      );
      grid.notifyChange(true);
      updateLayerThumbnail(activeLayerId, true);
      showToast(`Filter applied: ${type.replace('-', ' ')}`);
    },
    [
      hasOpenDocument,
      activeLayer,
      activeLayerId,
      selection,
      dimensions.width,
      dimensions.height,
      dimensions.dpi,
      layerCanvasesRef,
      layerSourceCanvasesRef,
      materializeLayerCanvas,
      releaseLayerCanvas,
      colorMode,
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
      let targetLayer = layers.find((l) => l.id === targetLayerId);
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
          targetLayer = candidate;
          setActiveLayerId(candidate.id);
          showToast(`Switched to "${candidate.name}" (active layer had no pixels)`);
        } else {
          showToast('Selected layer is empty. Draw or open an image first.');
          return;
        }
      }

      const displayCanvas = materializeLayerCanvas(targetLayerId);
      const isTone = Boolean(
        targetLayer?.toneEnabled && layerSourceCanvasesRef.current?.get(targetLayerId)
      );
      const sourceCanvas = layerSourceCanvasesRef.current?.get(targetLayerId);
      const canvas = isTone && sourceCanvas ? sourceCanvas : displayCanvas;

      if (!canvas) {
        showToast('Canvas not available for active layer.');
        return;
      }
      const ctx = get2DContext(canvas);
      if (!ctx) return;

      const beforeImageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
      const selectionMask = createSelectionMask(selection, canvas.width, canvas.height);
      const bounds = getProcessingBounds(selection, canvas.width, canvas.height);

      uiStoreActions.setTonalModalState({
        isOpen: true,
        type,
        targetLayerId,
        beforeImageData,
        selectionMask,
        bounds,
      });
    },
    [
      hasOpenDocument,
      activeLayer,
      activeLayerId,
      layers,
      selection,
      handleCommitFloatingSelection,
      materializeLayerCanvas,
      layerSourceCanvasesRef,
      setActiveLayerId,
      showToast,
    ]
  );

  const handleTonalPreviewChange = useCallback(
    (type: TonalCorrectionType, params: AnyTonalParams, enabled: boolean) => {
      const state = useUiStore.getState().tonalModalState;
      if (!state.isOpen || !state.beforeImageData) return;
      const targetLayerId = state.targetLayerId;
      const targetLayer = layers.find((l) => l.id === targetLayerId);
      const isTone = Boolean(
        targetLayer?.toneEnabled && layerSourceCanvasesRef.current?.get(targetLayerId)
      );
      const sourceCanvas = layerSourceCanvasesRef.current?.get(targetLayerId);
      const displayCanvas = layerCanvasesRef.current.get(targetLayerId);
      const canvas = isTone && sourceCanvas ? sourceCanvas : displayCanvas;
      if (!canvas) return;
      const ctx = get2DContext(canvas);
      if (!ctx) return;

      if (enabled) {
        const previewData = ctx.createImageData(canvas.width, canvas.height);
        applyTonalFilter(
          state.beforeImageData,
          previewData,
          type,
          params,
          state.selectionMask,
          state.bounds
        );
        ctx.putImageData(previewData, 0, 0);
      } else {
        ctx.putImageData(state.beforeImageData, 0, 0);
      }

      if (isTone && sourceCanvas && displayCanvas) {
        applyScreentone(sourceCanvas, displayCanvas, {
          frequency: targetLayer?.toneFrequency ?? 60,
          angle: targetLayer?.toneAngle ?? 45,
          dotShape: targetLayer?.toneDotShape ?? 'circle',
          dpi: dimensions.dpi ?? 600,
        });
      }

      if (displayCanvas) {
        const isMono =
          colorMode === 'monochrome' || targetLayer?.expressionColor === 'monochrome';
        documentStore
          .getActiveTileGrid()
          .ingestCanvas(targetLayerId, displayCanvas, isMono ? 'monochrome-1bit' : 'color-32bit');
        documentStore.getActiveTileGrid().notifyChange(true);
      }
    },
    [layers, colorMode, layerCanvasesRef, layerSourceCanvasesRef, dimensions.dpi]
  );

  const handleTonalApply = useCallback(
    (type: TonalCorrectionType, params: AnyTonalParams) => {
      const state = useUiStore.getState().tonalModalState;
      if (!state.isOpen || !state.beforeImageData) return;
      const targetLayerId = state.targetLayerId;
      const targetLayer = layers.find((l) => l.id === targetLayerId);
      const isTone = Boolean(
        targetLayer?.toneEnabled && layerSourceCanvasesRef.current?.get(targetLayerId)
      );
      const sourceCanvas = layerSourceCanvasesRef.current?.get(targetLayerId);
      const displayCanvas = layerCanvasesRef.current.get(targetLayerId);
      const canvas = isTone && sourceCanvas ? sourceCanvas : displayCanvas;
      if (!canvas) return;
      const ctx = get2DContext(canvas);
      if (!ctx) return;

      const finalData = ctx.createImageData(canvas.width, canvas.height);
      applyTonalFilter(
        state.beforeImageData,
        finalData,
        type,
        params,
        state.selectionMask,
        state.bounds
      );
      ctx.putImageData(finalData, 0, 0);

      if (isTone && sourceCanvas && displayCanvas) {
        applyScreentone(sourceCanvas, displayCanvas, {
          frequency: targetLayer?.toneFrequency ?? 60,
          angle: targetLayer?.toneAngle ?? 45,
          dotShape: targetLayer?.toneDotShape ?? 'circle',
          dpi: dimensions.dpi ?? 600,
        });
      }

      updateLayerThumbnail(targetLayerId, true);
      const label = getTonalLabel(type);
      pushHistoryStepRef.current?.(
        'tonal-correction',
        label,
        state.beforeImageData,
        finalData,
        targetLayerId
      );
      documentStore.getActiveTileGrid().notifyChange(true);
      if (!isTone) {
        releaseLayerCanvas(targetLayerId);
      }

      uiStoreActions.setTonalModalState({
        isOpen: false,
        type,
        targetLayerId: '',
        beforeImageData: null,
        selectionMask: null,
        bounds: { x0: 0, y0: 0, x1: 0, y1: 0 },
      });
      showToast(`Applied ${label}`);
    },
    [
      layers,
      layerCanvasesRef,
      layerSourceCanvasesRef,
      dimensions.dpi,
      updateLayerThumbnail,
      getTonalLabel,
      pushHistoryStepRef,
      releaseLayerCanvas,
      showToast,
    ]
  );

  const handleTonalCancel = useCallback(() => {
    const state = useUiStore.getState().tonalModalState;
    if (!state.isOpen) return;
    if (state.beforeImageData) {
      const targetLayerId = state.targetLayerId;
      const targetLayer = layers.find((l) => l.id === targetLayerId);
      const isTone = Boolean(
        targetLayer?.toneEnabled && layerSourceCanvasesRef.current?.get(targetLayerId)
      );
      const sourceCanvas = layerSourceCanvasesRef.current?.get(targetLayerId);
      const displayCanvas = layerCanvasesRef.current.get(targetLayerId);
      const canvas = isTone && sourceCanvas ? sourceCanvas : displayCanvas;
      if (canvas) {
        const ctx = get2DContext(canvas);
        if (ctx) {
          ctx.putImageData(state.beforeImageData, 0, 0);
          if (isTone && sourceCanvas && displayCanvas) {
            applyScreentone(sourceCanvas, displayCanvas, {
              frequency: targetLayer?.toneFrequency ?? 60,
              angle: targetLayer?.toneAngle ?? 45,
              dotShape: targetLayer?.toneDotShape ?? 'circle',
              dpi: dimensions.dpi ?? 600,
            });
          }
          if (displayCanvas) {
            const isMono =
              colorMode === 'monochrome' || targetLayer?.expressionColor === 'monochrome';
            documentStore
              .getActiveTileGrid()
              .ingestCanvas(
                targetLayerId,
                displayCanvas,
                isMono ? 'monochrome-1bit' : 'color-32bit'
              );
            documentStore.getActiveTileGrid().notifyChange(true);
            if (!isTone) {
              releaseLayerCanvas(targetLayerId);
            }
          }
        }
      }
    }

    uiStoreActions.setTonalModalState({
      isOpen: false,
      type: state.type,
      targetLayerId: '',
      beforeImageData: null,
      selectionMask: null,
      bounds: { x0: 0, y0: 0, x1: 0, y1: 0 },
    });
  }, [layers, colorMode, layerCanvasesRef, layerSourceCanvasesRef, dimensions.dpi, releaseLayerCanvas]);

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

    let targetLayerId = activeLayerId;
    let targetLayer = layers.find((l) => l.id === targetLayerId);
    let displayCanvas = layerCanvasesRef.current.get(targetLayerId);

    let hasPixels = false;
    if (displayCanvas) {
      const dCtx = get2DContext(displayCanvas);
      if (dCtx) {
        const dData = dCtx.getImageData(0, 0, displayCanvas.width, displayCanvas.height).data;
        for (let i = 3; i < dData.length; i += 4) {
          if (dData[i] > 0) {
            hasPixels = true;
            break;
          }
        }
      }
    }

    if (!hasPixels) {
      const candidate = layers.find((l) => {
        if (l.id === targetLayerId || l.type !== 'raster' || !l.visible) return false;
        const c = layerCanvasesRef.current.get(l.id);
        if (!c) return false;
        const cCtx = get2DContext(c);
        if (!cCtx) return false;
        const cData = cCtx.getImageData(0, 0, c.width, c.height).data;
        for (let j = 3; j < cData.length; j += 4) {
          if (cData[j] > 0) return true;
        }
        return false;
      });

      if (candidate) {
        targetLayerId = candidate.id;
        targetLayer = candidate;
        displayCanvas = layerCanvasesRef.current.get(candidate.id);
        setActiveLayerId(candidate.id);
        showToast(`Switched to "${candidate.name}" (active layer had no pixels)`);
      } else {
        showToast('Selected layer is empty. Draw or open an image first.');
        return;
      }
    }

    const isTone = Boolean(
      targetLayer?.toneEnabled && layerSourceCanvasesRef.current?.get(targetLayerId)
    );
    const sourceCanvas = layerSourceCanvasesRef.current?.get(targetLayerId);
    const canvas = isTone && sourceCanvas ? sourceCanvas : displayCanvas;
    if (!canvas) return;
    const ctx = get2DContext(canvas);
    if (!ctx) return;

    const beforeImageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const afterImageData = ctx.createImageData(canvas.width, canvas.height);
    afterImageData.data.set(beforeImageData.data);

    const mask = createSelectionMask(selection, canvas.width, canvas.height);
    const bounds = getProcessingBounds(selection, canvas.width, canvas.height);

    applyReverseGradient(beforeImageData, afterImageData, mask, bounds);
    ctx.putImageData(afterImageData, 0, 0);

    if (isTone && sourceCanvas && displayCanvas) {
      applyScreentone(sourceCanvas, displayCanvas, {
        frequency: targetLayer?.toneFrequency ?? 60,
        angle: targetLayer?.toneAngle ?? 45,
        dotShape: targetLayer?.toneDotShape ?? 'circle',
        dpi: dimensions.dpi ?? 600,
      });
    }

    updateLayerThumbnail(targetLayerId, true);
    pushHistoryStepRef.current?.(
      'tonal-correction',
      'Reverse Gradient',
      beforeImageData,
      afterImageData,
      targetLayerId
    );
    showToast('Inverted colors (Reverse Gradient)');
  }, [
    hasOpenDocument,
    activeLayer,
    activeLayerId,
    layers,
    selection,
    handleCommitFloatingSelection,
    layerCanvasesRef,
    layerSourceCanvasesRef,
    dimensions.dpi,
    updateLayerThumbnail,
    pushHistoryStepRef,
    setActiveLayerId,
    showToast,
  ]);

  const handleApplyMangaEffects = useCallback(
    (type: 'saturated' | 'stream', options: SaturatedLinesOptions | StreamLinesOptions) => {
      const canvas = getActiveCanvas();
      if (!canvas) return;
      const ctx = get2DContext(canvas);
      if (!ctx) return;

      const beforeImageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
      const sourceCanvas = layerSourceCanvasesRef.current?.get(activeLayerId);

      const renderOn = (target: HTMLCanvasElement) => {
        const c = get2DContext(target);
        if (!c) return;
        if (type === 'saturated') {
          renderSaturatedLines(c, canvas.width, canvas.height, options as SaturatedLinesOptions);
        } else {
          renderStreamLines(c, canvas.width, canvas.height, options as StreamLinesOptions);
        }
      };

      renderOn(canvas);
      if (sourceCanvas) renderOn(sourceCanvas);

      const afterImageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
      updateLayerThumbnail(activeLayerId, true);
      pushHistoryStepRef.current?.(
        'brush',
        `Manga Effect (${type})`,
        beforeImageData,
        afterImageData,
        activeLayerId
      );
      documentStore.getActiveTileGrid().notifyChange(true);
      showToast(`Applied manga ${type} lines`);
    },
    [
      getActiveCanvas,
      activeLayerId,
      layerSourceCanvasesRef,
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
      const { id, canvas } = fillScreentoneSelection(
        selection,
        settings.density,
        settings.frequency,
        settings.angle,
        settings.dotShape,
        settings.densityType
      );
      const ctx = get2DContext(canvas);
      if (ctx) {
        const afterData = ctx.getImageData(0, 0, canvas.width, canvas.height);
        pushHistoryStepRef.current?.(
          'screentone',
          `Screentone (${settings.density}%)`,
          null,
          afterData,
          id
        );
      }
      showToast(`Created Screentone Layer (${settings.density}%)`);
    },
    [selection, fillScreentoneSelection, pushHistoryStepRef, showToast]
  );

  const handleApplyExpressionColor = useCallback(
    (layerId: string) => {
      const result = applyExpressionColorOfPreview(layerId);
      if (result && result.beforeImageData && result.afterImageData) {
        pushHistoryStepRef.current?.(
          'expression-color',
          'Apply Expression Color',
          result.beforeImageData,
          result.afterImageData,
          layerId
        );
        showToast('Applied expression color to layer');
      }
    },
    [applyExpressionColorOfPreview, pushHistoryStepRef, showToast]
  );

  const handleApplyLayerColor = useCallback(
    (layerId: string) => {
      const result = applyLayerColorPermanently(layerId);
      if (result && result.beforeImageData && result.afterImageData) {
        pushHistoryStepRef.current?.(
          'layer-color',
          'Apply Layer Color Tint',
          result.beforeImageData,
          result.afterImageData,
          layerId
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
      if (result && result.beforeImageData && result.afterImageData) {
        pushHistoryStepRef.current?.(
          'layer-convert',
          `Convert to ${targetMode.toUpperCase()}`,
          result.beforeImageData,
          result.afterImageData,
          layerId
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
