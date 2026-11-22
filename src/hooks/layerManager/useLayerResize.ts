import { useCallback } from 'react';
import { CanvasDimensions, hasTileBackedLayer } from '../../types/editor';
import { ResizeCanvasOptions } from '../../types/settings';
import { createCanvasThumbnail, get2DContext } from '../../utils/canvasUtils';
import { releaseTemporaryCanvas } from '../../utils/tileEngine';
import { isBackgroundLayerId } from './layerTreeOps';
import { LayerManagerContext } from './types';

export function useLayerResize(ctx: LayerManagerContext) {
  const {
    dimensions,
    activeTileGridRef,
    layers,
    setLayers,
  } = ctx;

  // Resize canvas dimensions tile-by-tile directly inside SparseTileGrid (zero full-doc layer canvas)
  const resizeCanvas = useCallback(
    (
      newDims: CanvasDimensions,
      options: ResizeCanvasOptions = { width: newDims.width, height: newDims.height }
    ) => {
      const {
        scaleContent = false,
        anchor = 'center',
        backgroundColor = '#ffffff',
      } = options;

      const currentW = dimensions.width;
      const currentH = dimensions.height;
      const newW = newDims.width;
      const newH = newDims.height;

      let offsetX = 0;
      let offsetY = 0;

      if (!scaleContent) {
        if (anchor === 'top-left' || anchor === 'left' || anchor === 'bottom-left') {
          offsetX = 0;
        } else if (anchor === 'top-right' || anchor === 'right' || anchor === 'bottom-right') {
          offsetX = newW - currentW;
        } else {
          offsetX = Math.round((newW - currentW) / 2);
        }

        if (anchor === 'top-left' || anchor === 'top' || anchor === 'top-right') {
          offsetY = 0;
        } else if (anchor === 'bottom-left' || anchor === 'bottom' || anchor === 'bottom-right') {
          offsetY = newH - currentH;
        } else {
          offsetY = Math.round((newH - currentH) / 2);
        }
      }

      const updatedThumbnails = new Map<string, string>();
      const grid = activeTileGridRef.current;

      for (const layer of layers) {
        if (!hasTileBackedLayer(layer)) continue;
        const layerId = layer.id;
        const isBg = isBackgroundLayerId(layerId);
        const targetFormat =
          !isBg && layer.expressionColor === 'monochrome'
            ? 'monochrome-1bit'
            : !isBg && layer.expressionColor === 'gray'
              ? 'grayscale-8bit'
              : 'color-32bit';

        if (!grid.hasLayerTiles(layerId)) {
          if (isBg && backgroundColor !== 'transparent') {
            grid.fillLayerSolidColor(layerId, newW, newH, backgroundColor, 'color-32bit');
            updatedThumbnails.set(layerId, createCanvasThumbnail({ grid, layerId, dimensions: newDims }, false));
          } else {
            grid.setLayerFormat(layerId, targetFormat);
            grid.markLayerIngested(layerId);
          }
          continue;
        }

        grid.resizeLayerInGrid(layerId, dimensions, newDims, {
          scaleContent,
          offsetX,
          offsetY,
          isBackground: isBg,
          backgroundColor,
          targetFormat,
        });

        updatedThumbnails.set(layerId, createCanvasThumbnail({ grid, layerId, dimensions: newDims }, !isBg));
      }

      // Resize layer masks if present
      const updatedMasks = new Map<string, { maskCanvas: HTMLCanvasElement; maskThumb: string }>();
      layers.forEach((l) => {
        if (l.maskCanvas) {
          const tempMask = document.createElement('canvas');
          tempMask.width = l.maskCanvas.width;
          tempMask.height = l.maskCanvas.height;
          get2DContext(tempMask)?.drawImage(l.maskCanvas, 0, 0);

          l.maskCanvas.width = newW;
          l.maskCanvas.height = newH;
          const mCtx = get2DContext(l.maskCanvas);
          if (mCtx) {
            mCtx.fillStyle = '#ffffff';
            mCtx.fillRect(0, 0, newW, newH);
            if (scaleContent) {
              mCtx.drawImage(tempMask, 0, 0, tempMask.width, tempMask.height, 0, 0, newW, newH);
            } else {
              mCtx.drawImage(tempMask, offsetX, offsetY);
            }
          }
          releaseTemporaryCanvas(tempMask);
          updatedMasks.set(l.id, {
            maskCanvas: l.maskCanvas,
            maskThumb: createCanvasThumbnail(l.maskCanvas, false),
          });
        }
      });

      grid.notifyChange(true);

      setLayers((prev) =>
        prev.map((l) => {
          const newThumb = updatedThumbnails.get(l.id);
          const maskInfo = updatedMasks.get(l.id);
          if (!newThumb && !maskInfo) return l;
          return {
            ...l,
            ...(newThumb ? { thumbnailUrl: newThumb } : {}),
            ...(maskInfo
              ? {
                  maskCanvas: maskInfo.maskCanvas,
                  maskThumbnailUrl: maskInfo.maskThumb,
                  maskVersion: (l.maskVersion || 0) + 1,
                }
              : {}),
          };
        })
      );
    },
    [activeTileGridRef, dimensions, layers, setLayers]
  );

  return {
    resizeCanvas,
  };
}
