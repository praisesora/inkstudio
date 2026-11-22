import { useCallback } from 'react';
import { ExpressionColor, LayerItem } from '../../types/editor';
import { createCanvasThumbnail } from '../../utils/canvasUtils';
import {
  applyExpressionColorToImageData,
  applyLayerTintToImageData,
} from '../../utils/layerEffectsEngine';
import { HalftoneDotShape } from '../../utils/screentoneEngine';
import { TILE_SIZE, TileDelta, TileSnapshotEntry } from '../../utils/tileEngine';
import { LayerCanvasRegistryApi, LayerManagerContext } from './types';

export function useLayerEffects(
  ctx: LayerManagerContext,
  canvasRegistry: Pick<LayerCanvasRegistryApi, 'updateLayerThumbnail'>
) {
  const {
    activeTileGridRef,
    dimensionsRef,
    defaultToneFrequencyRef,
    layers,
    setLayers,
  } = ctx;
  const { updateLayerThumbnail } = canvasRegistry;

  // Toggle non-destructive screentone effect (rendered live on GPU by ViewportCompositor from raw tile data)
  const toggleTone = useCallback((id: string) => {
    setLayers((prev) => {
      const target = prev.find((l) => l.id === id);
      if (!target || target.type === 'folder') return prev;

      const newEnabled = !target.toneEnabled;
      const updatedLayer: LayerItem = {
        ...target,
        toneEnabled: newEnabled,
        toneFrequency: target.toneFrequency ?? defaultToneFrequencyRef.current ?? 60,
        toneAngle: target.toneAngle ?? 45,
        toneDotShape: target.toneDotShape ?? 'circle',
        toneDensity: target.toneDensity ?? 40,
        toneDensityType: target.toneDensityType ?? 'specified',
      };

      const grid = activeTileGridRef.current;
      let nextLayers = prev.map((l) => (l.id === id ? updatedLayer : l));

      // Ensure white paper background exists when enabling screentone on a transparent doc
      const hasBg = prev.some((l) => l.id.startsWith('layer-bg') || l.name.toLowerCase() === 'background');
      if (newEnabled && !hasBg) {
        const bgId = `layer-bg-${Date.now()}`;
        const dims = dimensionsRef.current;
        grid.fillLayerSolidWhite(bgId, dims.width, dims.height, 'color-32bit');
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

      grid.notifyChange(true);
      updateLayerThumbnail(id, false);
      return nextLayers;
    });
  }, [activeTileGridRef, defaultToneFrequencyRef, dimensionsRef, setLayers, updateLayerThumbnail]);

  // Update screentone frequency (Lines / LPI, 20 to 85)
  const setToneFrequency = useCallback((id: string, frequency: number) => {
    const clampedFreq = Math.max(20, Math.min(85, Math.round(frequency)));
    setLayers((prev) => {
      const target = prev.find((l) => l.id === id);
      if (!target || target.type === 'folder') return prev;
      if (target.toneEnabled) activeTileGridRef.current.notifyChange(true);
      return prev.map((l) => (l.id === id ? { ...l, toneFrequency: clampedFreq } : l));
    });
  }, [activeTileGridRef, setLayers]);

  // Update screentone angle (0 to 90 degrees)
  const setToneAngle = useCallback((id: string, angle: number) => {
    const clampedAngle = Math.max(0, Math.min(90, Math.round(angle)));
    setLayers((prev) => {
      const target = prev.find((l) => l.id === id);
      if (!target || target.type === 'folder') return prev;
      if (target.toneEnabled) activeTileGridRef.current.notifyChange(true);
      return prev.map((l) => (l.id === id ? { ...l, toneAngle: clampedAngle } : l));
    });
  }, [activeTileGridRef, setLayers]);

  // Update screentone dot shape (default: circle)
  const setToneDotShape = useCallback((id: string, dotShape: HalftoneDotShape) => {
    setLayers((prev) => {
      const target = prev.find((l) => l.id === id);
      if (!target || target.type === 'folder') return prev;
      if (target.toneEnabled) activeTileGridRef.current.notifyChange(true);
      return prev.map((l) => (l.id === id ? { ...l, toneDotShape: dotShape } : l));
    });
  }, [activeTileGridRef, setLayers]);

  // Update screentone density (1 to 100%)
  const setToneDensity = useCallback((id: string, density: number) => {
    const clampedDensity = Math.max(1, Math.min(100, Math.round(density)));
    setLayers((prev) => {
      const target = prev.find((l) => l.id === id);
      if (!target || target.type === 'folder') return prev;
      if (target.toneEnabled) activeTileGridRef.current.notifyChange(true);
      return prev.map((l) => (l.id === id ? { ...l, toneDensity: clampedDensity } : l));
    });
  }, [activeTileGridRef, setLayers]);

  // Update screentone density mode ('specified' vs 'image')
  const setToneDensityType = useCallback((id: string, densityType: 'specified' | 'image') => {
    setLayers((prev) => {
      const target = prev.find((l) => l.id === id);
      if (!target || target.type === 'folder') return prev;
      if (target.toneEnabled) activeTileGridRef.current.notifyChange(true);
      return prev.map((l) => (l.id === id ? { ...l, toneDensityType: densityType } : l));
    });
  }, [activeTileGridRef, setLayers]);

  // Toggle non-destructive Layer Color (Tint) effect (rendered on GPU)
  const toggleLayerColor = useCallback((id: string) => {
    setLayers((prev) => {
      const target = prev.find((l) => l.id === id);
      if (!target || target.type === 'folder') return prev;

      const updatedLayer: LayerItem = {
        ...target,
        layerColorEnabled: !target.layerColorEnabled,
        layerColor: target.layerColor || '#1c73c2',
        layerSubColor: target.layerSubColor || '#ffffff',
      };
      activeTileGridRef.current.notifyChange(true);
      return prev.map((l) => (l.id === id ? updatedLayer : l));
    });
  }, [activeTileGridRef, setLayers]);

  // Update Layer Color (Tint primary color)
  const setLayerColor = useCallback((id: string, color: string) => {
    setLayers((prev) => {
      const target = prev.find((l) => l.id === id);
      if (!target || target.type === 'folder') return prev;
      if (target.layerColorEnabled) activeTileGridRef.current.notifyChange(true);
      return prev.map((l) => (l.id === id ? { ...l, layerColor: color } : l));
    });
  }, [activeTileGridRef, setLayers]);

  // Update Layer Sub Color (Tint secondary color)
  const setLayerSubColor = useCallback((id: string, color: string) => {
    setLayers((prev) => {
      const target = prev.find((l) => l.id === id);
      if (!target || target.type === 'folder') return prev;
      if (target.layerColorEnabled) activeTileGridRef.current.notifyChange(true);
      return prev.map((l) => (l.id === id ? { ...l, layerSubColor: color } : l));
    });
  }, [activeTileGridRef, setLayers]);

  // Update non-destructive Expression Color preview ('color' | 'gray' | 'monochrome')
  const setLayerExpressionColor = useCallback((id: string, mode: ExpressionColor) => {
    setLayers((prev) => {
      const target = prev.find((l) => l.id === id);
      if (!target || target.type === 'folder') return prev;

      const updatedLayer: LayerItem = {
        ...target,
        expressionColor: mode,
        monoThreshold: target.monoThreshold ?? 128,
        monoExpressBlack: target.monoExpressBlack ?? true,
        monoExpressWhite: target.monoExpressWhite ?? true,
      };
      activeTileGridRef.current.notifyChange(true);
      return prev.map((l) => (l.id === id ? updatedLayer : l));
    });
  }, [activeTileGridRef, setLayers]);

  // Update Monochrome Color threshold (1 - 255)
  const setLayerMonoThreshold = useCallback((id: string, threshold: number) => {
    const clamped = Math.max(1, Math.min(255, Math.round(threshold)));
    setLayers((prev) => {
      const target = prev.find((l) => l.id === id);
      if (!target || target.type === 'folder') return prev;
      if (target.expressionColor === 'monochrome') activeTileGridRef.current.notifyChange(true);
      return prev.map((l) => (l.id === id ? { ...l, monoThreshold: clamped } : l));
    });
  }, [activeTileGridRef, setLayers]);

  // Update Monochrome Express Colors (express black, express white)
  const setLayerMonoExpressMode = useCallback((id: string, expressBlack: boolean, expressWhite: boolean) => {
    setLayers((prev) => {
      const target = prev.find((l) => l.id === id);
      if (!target || target.type === 'folder') return prev;
      if (target.expressionColor === 'monochrome') activeTileGridRef.current.notifyChange(true);
      return prev.map((l) =>
        l.id === id ? { ...l, monoExpressBlack: expressBlack, monoExpressWhite: expressWhite } : l
      );
    });
  }, [activeTileGridRef, setLayers]);

  // Bake previewed expression color permanently into SparseTileGrid tiles (tile-native, zero full-doc canvas)
  const applyExpressionColorOfPreview = useCallback(
    (id: string): { tileDeltas: TileDelta[] } | null => {
      const target = layers.find((l) => l.id === id);
      if (!target || target.type === 'folder') return null;

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
    [activeTileGridRef, layers, updateLayerThumbnail]
  );

  // Bake layer color tint permanently into SparseTileGrid tiles and disable layerColorEnabled
  const applyLayerColorPermanently = useCallback(
    (id: string): { tileDeltas: TileDelta[] } | null => {
      const target = layers.find((l) => l.id === id);
      if (!target || target.type === 'folder' || !target.layerColorEnabled) return null;

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

      setLayers((prev) =>
        prev.map((l) => (l.id === id ? { ...l, layerColorEnabled: false } : l))
      );

      if (!modified) {
        grid.notifyChange(true);
        return { tileDeltas: [] };
      }

      const tileDeltas = grid.computeDeltasFromSnapshot(beforeSnapshot, id);
      updateLayerThumbnail(id, true);
      return { tileDeltas };
    },
    [activeTileGridRef, layers, setLayers, updateLayerThumbnail]
  );

  // Direct permanent conversion of any layer to Color, Gray, or Monochrome (tile-native)
  const convertLayer = useCallback(
    (
      id: string,
      targetMode: ExpressionColor,
      options?: { threshold?: number; expressBlack?: boolean; expressWhite?: boolean }
    ): { tileDeltas: TileDelta[] } | null => {
      const target = layers.find((l) => l.id === id);
      if (!target || target.type === 'folder') return null;

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
      setLayers((prev) => prev.map((l) => (l.id === id ? updatedLayer : l)));
      grid.notifyChange(true);
      updateLayerThumbnail(id, true);
      return { tileDeltas };
    },
    [activeTileGridRef, layers, setLayers, updateLayerThumbnail]
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
