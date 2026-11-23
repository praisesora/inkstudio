import { useCallback } from 'react';
import {
  CanvasSelection,
  ExpressionColor,
  LayerItem,
  LayerTreeDelta,
  isDedicatedToneLayer,
  isFolderLikeLayer,
} from '../../types/editor';
import { createCanvasThumbnail } from '../../utils/canvasUtils';
import {
  applyExpressionColorToImageData,
  applyLayerTintToImageData,
} from '../../utils/layerEffectsEngine';
import { HalftoneDotShape } from '../../utils/screentoneEngine';
import { fillSelectionInTileGrid } from '../../utils/selectionUtils';
import { TILE_SIZE, TileDelta, TileSnapshotEntry } from '../../utils/tileEngine';
import { createLayerTreeSnapshotDelta } from './layerTreeOps';
import { LayerCanvasRegistryApi, LayerManagerContext } from './types';

export function useLayerEffects(
  ctx: LayerManagerContext,
  canvasRegistry: Pick<LayerCanvasRegistryApi, 'updateLayerThumbnail'>
) {
  const {
    activeTileGridRef,
    dimensionsRef,
    defaultToneFrequencyRef,
    layersRef,
    activeLayerIdRef,
    setLayers,
    recordLayerHistory,
  } = ctx;
  const { updateLayerThumbnail } = canvasRegistry;

  // Toggle non-destructive screentone effect (rendered live on GPU by ViewportCompositor from raw tile data).
  // When enabling screentone on an empty raster layer while a selection is active, automatically fills
  // the selection with tone so checking "Screentone" after Lasso/Marquee/Wand works immediately!
  const toggleTone = useCallback((id: string, activeSelection?: CanvasSelection | null) => {
    const prev = layersRef.current;
    const target = prev.find((l) => l.id === id);
    if (!target || isFolderLikeLayer(target)) return;

    const grid = activeTileGridRef.current;
    const dims = dimensionsRef.current;
    const newEnabled = !target.toneEnabled;
    const shouldFillSelection =
      newEnabled &&
      Boolean(activeSelection) &&
      target.type === 'raster' &&
      !target.locked &&
      !grid.hasLayerTiles(id);

    let tileDeltas: TileDelta[] = [];
    if (shouldFillSelection && activeSelection) {
      const fillRes = fillSelectionInTileGrid({
        grid,
        layerId: id,
        dimensions: dims,
        selection: activeSelection,
        colorCss: 'rgb(0,0,0)',
        targetFormat: 'color-32bit',
      });
      tileDeltas = fillRes.tileDeltas;
    }

    const isToneLayer = shouldFillSelection ? true : isDedicatedToneLayer(target);
    const updatedLayer: LayerItem = {
      ...target,
      isToneLayer: shouldFillSelection ? true : target.isToneLayer,
      toneEnabled: newEnabled,
      toneFrequency: target.toneFrequency ?? defaultToneFrequencyRef.current ?? 60,
      toneAngle: target.toneAngle ?? 45,
      toneDotShape: target.toneDotShape ?? 'circle',
      toneDensity: target.toneDensity ?? 40,
      toneDensityType: isToneLayer ? 'specified' : 'image',
    };

    let nextLayers = prev.map((l) => (l.id === id ? updatedLayer : l));

    // Ensure white paper background exists when enabling screentone on a transparent doc
    const hasBg = prev.some((l) => l.id.startsWith('layer-bg') || l.name.toLowerCase() === 'background');
    if (newEnabled && !hasBg) {
      const bgId = `layer-bg-${Date.now()}`;
      grid.fillLayerSolidWhite(bgId, dims.width, dims.height, 'color-32bit');
      const bgDeltas = grid.computeDeltasFromSnapshot(new Map(), bgId, {
        x: 0,
        y: 0,
        width: dims.width,
        height: dims.height,
      });
      tileDeltas = [...tileDeltas, ...bgDeltas];
      const bgThumb = createCanvasThumbnail({ grid, layerId: bgId, dimensions: dims }, false);
      const bgLayer: LayerItem = {
        id: bgId,
        name: 'Background',
        type: 'raster',
        visible: true,
        opacity: 1,
        blendMode: 'normal',
        locked: true,
        parentId: null,
        thumbnailUrl: bgThumb,
      };
      nextLayers = [...nextLayers, bgLayer];
    }

    layersRef.current = nextLayers;
    setLayers(nextLayers);
    grid.notifyChange(true);
    updateLayerThumbnail(id, shouldFillSelection);
    recordLayerHistory(
      newEnabled ? (shouldFillSelection ? 'Screentone Selection' : 'Enable Screentone') : 'Disable Screentone',
      id,
      createLayerTreeSnapshotDelta(prev, nextLayers, activeLayerIdRef.current, activeLayerIdRef.current),
      tileDeltas,
      'screentone'
    );
  }, [activeLayerIdRef, activeTileGridRef, defaultToneFrequencyRef, dimensionsRef, layersRef, recordLayerHistory, setLayers, updateLayerThumbnail]);

  // Update screentone frequency (Lines / LPI, 20 to 85)
  const setToneFrequency = useCallback((id: string, frequency: number) => {
    const clampedFreq = Math.max(20, Math.min(85, Math.round(frequency)));
    const prev = layersRef.current;
    const target = prev.find((l) => l.id === id);
    if (!target || isFolderLikeLayer(target) || target.toneFrequency === clampedFreq) return;
    const next = prev.map((l) => (l.id === id ? { ...l, toneFrequency: clampedFreq } : l));
    layersRef.current = next;
    setLayers(next);
    if (target.toneEnabled) activeTileGridRef.current.notifyChange(true);
    recordLayerHistory(
      'Screentone Frequency',
      id,
      createLayerTreeSnapshotDelta(prev, next, activeLayerIdRef.current, activeLayerIdRef.current, {
        coalesceKey: `toneFreq:${id}`,
      }),
      undefined,
      'screentone'
    );
  }, [activeLayerIdRef, activeTileGridRef, layersRef, recordLayerHistory, setLayers]);

  // Update screentone angle (0 to 90 degrees)
  const setToneAngle = useCallback((id: string, angle: number) => {
    const clampedAngle = Math.max(0, Math.min(90, Math.round(angle)));
    const prev = layersRef.current;
    const target = prev.find((l) => l.id === id);
    if (!target || isFolderLikeLayer(target) || target.toneAngle === clampedAngle) return;
    const next = prev.map((l) => (l.id === id ? { ...l, toneAngle: clampedAngle } : l));
    layersRef.current = next;
    setLayers(next);
    if (target.toneEnabled) activeTileGridRef.current.notifyChange(true);
    recordLayerHistory(
      'Screentone Angle',
      id,
      createLayerTreeSnapshotDelta(prev, next, activeLayerIdRef.current, activeLayerIdRef.current, {
        coalesceKey: `toneAngle:${id}`,
      }),
      undefined,
      'screentone'
    );
  }, [activeLayerIdRef, activeTileGridRef, layersRef, recordLayerHistory, setLayers]);

  // Update screentone dot shape (default: circle)
  const setToneDotShape = useCallback((id: string, dotShape: HalftoneDotShape) => {
    const prev = layersRef.current;
    const target = prev.find((l) => l.id === id);
    if (!target || isFolderLikeLayer(target) || target.toneDotShape === dotShape) return;
    const next = prev.map((l) => (l.id === id ? { ...l, toneDotShape: dotShape } : l));
    layersRef.current = next;
    setLayers(next);
    if (target.toneEnabled) activeTileGridRef.current.notifyChange(true);
    recordLayerHistory(
      'Screentone Dot Shape',
      id,
      createLayerTreeSnapshotDelta(prev, next, activeLayerIdRef.current, activeLayerIdRef.current),
      undefined,
      'screentone'
    );
  }, [activeLayerIdRef, activeTileGridRef, layersRef, recordLayerHistory, setLayers]);

  // Update screentone density (1 to 100%)
  const setToneDensity = useCallback((id: string, density: number) => {
    const clampedDensity = Math.max(1, Math.min(100, Math.round(density)));
    const prev = layersRef.current;
    const target = prev.find((l) => l.id === id);
    if (!target || isFolderLikeLayer(target) || target.toneDensity === clampedDensity) return;
    const next = prev.map((l) => (l.id === id ? { ...l, toneDensity: clampedDensity } : l));
    layersRef.current = next;
    setLayers(next);
    if (target.toneEnabled) activeTileGridRef.current.notifyChange(true);
    recordLayerHistory(
      'Screentone Density',
      id,
      createLayerTreeSnapshotDelta(prev, next, activeLayerIdRef.current, activeLayerIdRef.current, {
        coalesceKey: `toneDensity:${id}`,
      }),
      undefined,
      'screentone'
    );
  }, [activeLayerIdRef, activeTileGridRef, layersRef, recordLayerHistory, setLayers]);

  // Update screentone density mode ('specified' vs 'image')
  const setToneDensityType = useCallback((id: string, densityType: 'specified' | 'image') => {
    const prev = layersRef.current;
    const target = prev.find((l) => l.id === id);
    if (!target || isFolderLikeLayer(target) || target.toneDensityType === densityType) return;
    const next = prev.map((l) =>
      l.id === id
        ? { ...l, toneDensityType: densityType, isToneLayer: densityType === 'specified' }
        : l
    );
    layersRef.current = next;
    setLayers(next);
    if (target.toneEnabled) activeTileGridRef.current.notifyChange(true);
    recordLayerHistory(
      'Screentone Density Mode',
      id,
      createLayerTreeSnapshotDelta(prev, next, activeLayerIdRef.current, activeLayerIdRef.current),
      undefined,
      'screentone'
    );
  }, [activeLayerIdRef, activeTileGridRef, layersRef, recordLayerHistory, setLayers]);

  // Toggle non-destructive Layer Color (Tint) effect (rendered on GPU)
  const toggleLayerColor = useCallback((id: string) => {
    const prev = layersRef.current;
    const target = prev.find((l) => l.id === id);
    if (!target || isFolderLikeLayer(target)) return;

    const updatedLayer: LayerItem = {
      ...target,
      layerColorEnabled: !target.layerColorEnabled,
      layerColor: target.layerColor || '#1c73c2',
      layerSubColor: target.layerSubColor || '#ffffff',
    };
    const next = prev.map((l) => (l.id === id ? updatedLayer : l));
    layersRef.current = next;
    setLayers(next);
    activeTileGridRef.current.notifyChange(true);
    recordLayerHistory(
      updatedLayer.layerColorEnabled ? 'Enable Layer Tint' : 'Disable Layer Tint',
      id,
      createLayerTreeSnapshotDelta(prev, next, activeLayerIdRef.current, activeLayerIdRef.current),
      undefined,
      'layer-color'
    );
  }, [activeLayerIdRef, activeTileGridRef, layersRef, recordLayerHistory, setLayers]);

  // Update Layer Color (Tint primary color)
  const setLayerColor = useCallback((id: string, color: string) => {
    const prev = layersRef.current;
    const target = prev.find((l) => l.id === id);
    if (!target || isFolderLikeLayer(target) || target.layerColor === color) return;
    const next = prev.map((l) => (l.id === id ? { ...l, layerColor: color } : l));
    layersRef.current = next;
    setLayers(next);
    if (target.layerColorEnabled) activeTileGridRef.current.notifyChange(true);
    recordLayerHistory(
      'Layer Tint Color',
      id,
      createLayerTreeSnapshotDelta(prev, next, activeLayerIdRef.current, activeLayerIdRef.current, {
        coalesceKey: `layerColor:${id}`,
      }),
      undefined,
      'layer-color'
    );
  }, [activeLayerIdRef, activeTileGridRef, layersRef, recordLayerHistory, setLayers]);

  // Update Layer Sub Color (Tint secondary color)
  const setLayerSubColor = useCallback((id: string, color: string) => {
    const prev = layersRef.current;
    const target = prev.find((l) => l.id === id);
    if (!target || isFolderLikeLayer(target) || target.layerSubColor === color) return;
    const next = prev.map((l) => (l.id === id ? { ...l, layerSubColor: color } : l));
    layersRef.current = next;
    setLayers(next);
    if (target.layerColorEnabled) activeTileGridRef.current.notifyChange(true);
    recordLayerHistory(
      'Layer Sub Color',
      id,
      createLayerTreeSnapshotDelta(prev, next, activeLayerIdRef.current, activeLayerIdRef.current, {
        coalesceKey: `layerSubColor:${id}`,
      }),
      undefined,
      'layer-color'
    );
  }, [activeLayerIdRef, activeTileGridRef, layersRef, recordLayerHistory, setLayers]);

  // Update non-destructive Expression Color preview ('color' | 'gray' | 'monochrome')
  const setLayerExpressionColor = useCallback((id: string, mode: ExpressionColor) => {
    const prev = layersRef.current;
    const target = prev.find((l) => l.id === id);
    if (!target || isFolderLikeLayer(target) || target.expressionColor === mode) return;

    const updatedLayer: LayerItem = {
      ...target,
      expressionColor: mode,
      monoThreshold: target.monoThreshold ?? 128,
      monoExpressBlack: target.monoExpressBlack ?? true,
      monoExpressWhite: target.monoExpressWhite ?? true,
    };
    const next = prev.map((l) => (l.id === id ? updatedLayer : l));
    layersRef.current = next;
    setLayers(next);
    activeTileGridRef.current.notifyChange(true);
    recordLayerHistory(
      `Expression Color (${mode})`,
      id,
      createLayerTreeSnapshotDelta(prev, next, activeLayerIdRef.current, activeLayerIdRef.current),
      undefined,
      'expression-color'
    );
  }, [activeLayerIdRef, activeTileGridRef, layersRef, recordLayerHistory, setLayers]);

  // Update Monochrome Color threshold (1 - 255)
  const setLayerMonoThreshold = useCallback((id: string, threshold: number) => {
    const clamped = Math.max(1, Math.min(255, Math.round(threshold)));
    const prev = layersRef.current;
    const target = prev.find((l) => l.id === id);
    if (!target || isFolderLikeLayer(target) || target.monoThreshold === clamped) return;
    const next = prev.map((l) => (l.id === id ? { ...l, monoThreshold: clamped } : l));
    layersRef.current = next;
    setLayers(next);
    if (target.expressionColor === 'monochrome') activeTileGridRef.current.notifyChange(true);
    recordLayerHistory(
      'Monochrome Threshold',
      id,
      createLayerTreeSnapshotDelta(prev, next, activeLayerIdRef.current, activeLayerIdRef.current, {
        coalesceKey: `monoThreshold:${id}`,
      }),
      undefined,
      'expression-color'
    );
  }, [activeLayerIdRef, activeTileGridRef, layersRef, recordLayerHistory, setLayers]);

  // Update Monochrome Express Colors (express black, express white)
  const setLayerMonoExpressMode = useCallback((id: string, expressBlack: boolean, expressWhite: boolean) => {
    const prev = layersRef.current;
    const target = prev.find((l) => l.id === id);
    if (!target || isFolderLikeLayer(target)) return;
    const next = prev.map((l) =>
      l.id === id ? { ...l, monoExpressBlack: expressBlack, monoExpressWhite: expressWhite } : l
    );
    layersRef.current = next;
    setLayers(next);
    if (target.expressionColor === 'monochrome') activeTileGridRef.current.notifyChange(true);
    recordLayerHistory(
      'Monochrome Expression',
      id,
      createLayerTreeSnapshotDelta(prev, next, activeLayerIdRef.current, activeLayerIdRef.current),
      undefined,
      'expression-color'
    );
  }, [activeLayerIdRef, activeTileGridRef, layersRef, recordLayerHistory, setLayers]);

  // Bake previewed expression color permanently into SparseTileGrid tiles (tile-native, zero full-doc canvas)
  const applyExpressionColorOfPreview = useCallback(
    (id: string): { tileDeltas: TileDelta[] } | null => {
      const target = layersRef.current.find((l) => l.id === id);
      if (!target || isFolderLikeLayer(target)) return null;

      const exprMode = target.expressionColor || 'color';
      if (exprMode === 'color') return null;

      const grid = activeTileGridRef.current;
      const beforeSnapshot = new Map<string, TileSnapshotEntry>();
      const targetFormat =
        exprMode === 'monochrome'
          ? 'monochrome-1bit'
          : exprMode === 'gray'
            ? 'grayscale-8bit'
            : 'color-32bit';

      const modified = grid.transformLayerTiles(
        id,
        (rgba) => {
          const fakeImgData = { data: rgba, width: TILE_SIZE, height: TILE_SIZE } as ImageData;
          applyExpressionColorToImageData(fakeImgData, exprMode, {
            threshold: target.monoThreshold ?? 128,
            expressBlack: target.monoExpressBlack ?? true,
            expressWhite: target.monoExpressWhite ?? true,
          });
          return true;
        },
        {
          targetFormat,
          monoThreshold: target.monoThreshold ?? 128,
          snapshotOut: beforeSnapshot,
        }
      );

      if (!modified) return null;
      const tileDeltas = grid.computeDeltasFromSnapshot(beforeSnapshot, id);
      updateLayerThumbnail(id, true);
      return { tileDeltas };
    },
    [activeTileGridRef, layersRef, updateLayerThumbnail]
  );

  // Bake layer color tint permanently into SparseTileGrid tiles and disable layerColorEnabled
  const applyLayerColorPermanently = useCallback(
    (id: string): { tileDeltas: TileDelta[]; layerTreeDelta: LayerTreeDelta } | null => {
      const prev = layersRef.current;
      const target = prev.find((l) => l.id === id);
      if (!target || isFolderLikeLayer(target) || !target.layerColorEnabled) return null;

      const grid = activeTileGridRef.current;
      const beforeSnapshot = new Map<string, TileSnapshotEntry>();

      const modified = grid.transformLayerTiles(
        id,
        (rgba) => {
          const fakeImgData = { data: rgba, width: TILE_SIZE, height: TILE_SIZE } as ImageData;
          applyLayerTintToImageData(fakeImgData, target.layerColor, target.layerSubColor);
          return true;
        },
        {
          targetFormat: 'color-32bit',
          snapshotOut: beforeSnapshot,
        }
      );

      const next = prev.map((l) => (l.id === id ? { ...l, layerColorEnabled: false } : l));
      layersRef.current = next;
      setLayers(next);
      const layerTreeDelta = createLayerTreeSnapshotDelta(
        prev,
        next,
        activeLayerIdRef.current,
        activeLayerIdRef.current
      );

      if (!modified) {
        grid.notifyChange(true);
        return { tileDeltas: [], layerTreeDelta };
      }

      const tileDeltas = grid.computeDeltasFromSnapshot(beforeSnapshot, id);
      updateLayerThumbnail(id, true);
      return { tileDeltas, layerTreeDelta };
    },
    [activeLayerIdRef, activeTileGridRef, layersRef, setLayers, updateLayerThumbnail]
  );

  // Direct permanent conversion of any layer to Color, Gray, or Monochrome (tile-native)
  const convertLayer = useCallback(
    (
      id: string,
      targetMode: ExpressionColor,
      options?: { threshold?: number; expressBlack?: boolean; expressWhite?: boolean }
    ): { tileDeltas: TileDelta[]; layerTreeDelta: LayerTreeDelta } | null => {
      const prev = layersRef.current;
      const target = prev.find((l) => l.id === id);
      if (!target || isFolderLikeLayer(target)) return null;

      const grid = activeTileGridRef.current;
      const beforeSnapshot = new Map<string, TileSnapshotEntry>();
      const threshold = options?.threshold ?? target.monoThreshold ?? 128;
      const expressBlack = options?.expressBlack ?? target.monoExpressBlack ?? true;
      const expressWhite = options?.expressWhite ?? target.monoExpressWhite ?? true;
      const targetFormat =
        targetMode === 'monochrome'
          ? 'monochrome-1bit'
          : targetMode === 'gray'
            ? 'grayscale-8bit'
            : 'color-32bit';

      const updatedLayer: LayerItem = {
        ...target,
        expressionColor: targetMode,
        monoThreshold: threshold,
        monoExpressBlack: expressBlack,
        monoExpressWhite: expressWhite,
      };

      grid.transformLayerTiles(
        id,
        (rgba) => {
          const fakeImgData = { data: rgba, width: TILE_SIZE, height: TILE_SIZE } as ImageData;
          if (targetMode !== 'color') {
            applyExpressionColorToImageData(fakeImgData, targetMode, {
              threshold,
              expressBlack,
              expressWhite,
            });
          }
          return true;
        },
        {
          targetFormat,
          monoThreshold: threshold,
          snapshotOut: beforeSnapshot,
        }
      );

      grid.setLayerFormat(id, targetFormat);
      const tileDeltas = grid.computeDeltasFromSnapshot(beforeSnapshot, id);
      const next = prev.map((l) => (l.id === id ? updatedLayer : l));
      layersRef.current = next;
      setLayers(next);
      grid.notifyChange(true);
      updateLayerThumbnail(id, true);
      const layerTreeDelta = createLayerTreeSnapshotDelta(
        prev,
        next,
        activeLayerIdRef.current,
        activeLayerIdRef.current
      );
      return { tileDeltas, layerTreeDelta };
    },
    [activeLayerIdRef, activeTileGridRef, layersRef, setLayers, updateLayerThumbnail]
  );

  return {
    toggleTone,
    setToneFrequency,
    setToneAngle,
    setToneDotShape,
    setToneDensity,
    setToneDensityType,
    toggleLayerColor,
    setLayerColor,
    setLayerSubColor,
    setLayerExpressionColor,
    setLayerMonoThreshold,
    setLayerMonoExpressMode,
    applyExpressionColorOfPreview,
    applyLayerColorPermanently,
    convertLayer,
  };
}
