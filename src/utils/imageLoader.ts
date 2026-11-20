import { LoadedDocument, LayerItem, CanvasColorMode, isFolderLikeLayer } from '../types/editor';
import { createCanvasThumbnail } from './canvasUtils';
import { renderVectorLayer } from './vectorEngine';
import { renderBalloonLayerData, renderTextLayerData } from './vectorLayerRenderer';
import { parseSoraProject } from './saveManager';
import { releaseTemporaryCanvas } from './tileEngine';

/**
 * Loads standard raster/vector image formats (.png, .jpg, .jpeg, .webp, .bmp, .gif, .svg).
 */
export async function loadStandardImage(file: File): Promise<LoadedDocument> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();

    reader.onload = (e) => {
      const img = new Image();
      img.onload = () => {
        const width = img.naturalWidth || 1440;
        const height = img.naturalHeight || 900;

        const layerId = `layer-${Date.now()}`;
        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext('2d');
        if (ctx) {
          ctx.drawImage(img, 0, 0);
        }

        const bgId = `layer-bg-${Date.now()}`;
        const bgCanvas = document.createElement('canvas');
        bgCanvas.width = width;
        bgCanvas.height = height;
        const bgCtx = bgCanvas.getContext('2d');
        if (bgCtx) {
          bgCtx.fillStyle = '#ffffff';
          bgCtx.fillRect(0, 0, width, height);
        }

        const layerCanvases = new Map<string, HTMLCanvasElement>();
        layerCanvases.set(layerId, canvas);
        layerCanvases.set(bgId, bgCanvas);

        const thumb = createCanvasThumbnail(canvas, false);
        const bgThumb = createCanvasThumbnail(bgCanvas, false);

        const layers: LayerItem[] = [
          {
            id: layerId,
            name: file.name.replace(/\.[^/.]+$/, ''),
            type: 'raster',
            visible: true,
            opacity: 1,
            blendMode: 'normal',
            locked: false,
            parentId: null,
            thumbnailUrl: thumb,
          },
          {
            id: bgId,
            name: 'Background',
            type: 'raster',
            visible: true,
            opacity: 1,
            blendMode: 'normal',
            locked: true,
            parentId: null,
            thumbnailUrl: bgThumb,
          },
        ];

        resolve({
          name: file.name.replace(/\.[^/.]+$/, ''),
          dimensions: { width, height, dpi: 600 },
          colorMode: 'color' as CanvasColorMode,
          layers,
          layerCanvases,
        });
      };

      img.onerror = (err) => reject(new Error('Failed to load image element: ' + err));
      img.src = e.target?.result as string;
    };

    reader.onerror = () => reject(new Error('Failed to read file.'));
    reader.readAsDataURL(file);
  });
}

/**
 * Universal file opener detecting file extension and loading image, PSD, or CSP files.
 */
export async function openFile(file: File): Promise<LoadedDocument> {
  const ext = file.name.slice(file.name.lastIndexOf('.')).toLowerCase();

  if (ext === '.psd' || ext === '.psb') {
    const { parsePsdFile } = await import('./psdParser');
    const buffer = await file.arrayBuffer();
    return await parsePsdFile(buffer, file.name);
  }

  if (ext === '.clip' || ext === '.csp') {
    const { parseCspFile } = await import('./cspParser');
    const buffer = await file.arrayBuffer();
    return await parseCspFile(buffer, file.name);
  }

  if (ext === '.ink' || ext === '.sora' || ext === '.json') {
    try {
      const buffer = await file.arrayBuffer();
      const project = await parseSoraProject(buffer);
      if (project.layers && Array.isArray(project.layers)) {
        const width = project.dimensions.width;
        const height = project.dimensions.height;
        const dpi = project.dimensions.dpi || 300;
        const colorMode: CanvasColorMode = project.colorMode || 'color';
        const layers: LayerItem[] = project.layers;

        // Fast native binary v2 path: tiles are already populated directly into SparseTileGrid
        if (project.format === 'v2' && project.tileGrid) {
          const grid = project.tileGrid;
          if (typeof document !== 'undefined') {
            for (const layer of layers) {
              if (grid.hasLayerTiles(layer.id)) continue;
              if (layer.type === 'text' && layer.textData) {
                const temp = document.createElement('canvas');
                temp.width = width;
                temp.height = height;
                const ctx = temp.getContext('2d');
                if (ctx) renderTextLayerData(ctx, layer.textData);
                grid.ingestCanvas(layer.id, temp, grid.getLayerFormat(layer.id));
                releaseTemporaryCanvas(temp);
              } else if (layer.type === 'balloon' && layer.balloonData) {
                const temp = document.createElement('canvas');
                temp.width = width;
                temp.height = height;
                const ctx = temp.getContext('2d');
                if (ctx) renderBalloonLayerData(ctx, layer.balloonData);
                grid.ingestCanvas(layer.id, temp, grid.getLayerFormat(layer.id));
                releaseTemporaryCanvas(temp);
              } else if (layer.type === 'vector' && layer.vectorStrokes && layer.vectorStrokes.length > 0) {
                const temp = document.createElement('canvas');
                temp.width = width;
                temp.height = height;
                const ctx = temp.getContext('2d');
                if (ctx) renderVectorLayer(ctx, layer.vectorStrokes);
                grid.ingestCanvas(layer.id, temp, grid.getLayerFormat(layer.id));
                releaseTemporaryCanvas(temp);
              }
            }
          }

          return {
            name: project.name || file.name.replace(/\.[^/.]+$/, ''),
            dimensions: { width, height, dpi },
            colorMode,
            layers,
            tileGrid: grid,
            perspectiveRuler: project.perspectiveRuler ?? null,
            animationTimeline: project.animationTimeline ?? null,
            timelapse: project.timelapse ?? null,
            previewDataUrl: project.previewDataUrl,
          };
        }

        // Legacy v1.2 JSON path: reconstruct canvases from base64 PNG data URLs
        const layerCanvases = new Map<string, HTMLCanvasElement>();

        const loadPromises = layers.map((layer) => {
          const tasks: Promise<void>[] = [];

          // Reconstruct maskCanvas if saved in project.masks
          const maskDataUrl = project.masks?.[layer.id];
          if (maskDataUrl) {
            tasks.push(
              new Promise<void>((resolve) => {
                const mCanvas = document.createElement('canvas');
                mCanvas.width = width;
                mCanvas.height = height;
                const mImg = new Image();
                mImg.onload = () => {
                  mCanvas.getContext('2d')?.drawImage(mImg, 0, 0);
                  layer.maskCanvas = mCanvas;
                  layer.maskVersion = (layer.maskVersion || 0) + 1;
                  resolve();
                };
                mImg.onerror = () => resolve();
                mImg.src = maskDataUrl;
              })
            );
          }

          if (!isFolderLikeLayer(layer) && layer.type !== 'adjustment') {
            tasks.push(
              new Promise<void>((resolve) => {
                const canvas = document.createElement('canvas');
                canvas.width = width;
                canvas.height = height;

                // Always re-render non-destructive text/balloon from crisp vector data when available
                if (layer.type === 'text' && layer.textData) {
                  const ctx = canvas.getContext('2d');
                  if (ctx) renderTextLayerData(ctx, layer.textData);
                  layerCanvases.set(layer.id, canvas);
                  resolve();
                  return;
                }
                if (layer.type === 'balloon' && layer.balloonData) {
                  const ctx = canvas.getContext('2d');
                  if (ctx) renderBalloonLayerData(ctx, layer.balloonData);
                  layerCanvases.set(layer.id, canvas);
                  resolve();
                  return;
                }

                const dataUrl = project.canvases?.[layer.id];
                if (dataUrl) {
                  const img = new Image();
                  img.onload = () => {
                    const ctx = canvas.getContext('2d');
                    ctx?.drawImage(img, 0, 0);
                    layerCanvases.set(layer.id, canvas);
                    resolve();
                  };
                  img.onerror = () => {
                    layerCanvases.set(layer.id, canvas);
                    resolve();
                  };
                  img.src = dataUrl;
                } else {
                  if (layer.type === 'vector' && layer.vectorStrokes && layer.vectorStrokes.length > 0) {
                    const ctx = canvas.getContext('2d');
                    if (ctx) renderVectorLayer(ctx, layer.vectorStrokes);
                  }
                  layerCanvases.set(layer.id, canvas);
                  resolve();
                }
              })
            );
          }

          return Promise.all(tasks).then(() => {});
        });

        await Promise.all(loadPromises);

        return {
          name: project.name || file.name.replace(/\.[^/.]+$/, ''),
          dimensions: { width, height, dpi },
          colorMode,
          layers,
          layerCanvases,
        };
      }
    } catch (err) {
      console.warn('Failed to parse .sora project, falling back to image loader:', err);
    }
  }

  // Common image extensions: .png, .jpg, .jpeg, .webp, .bmp, .gif, .svg
  return await loadStandardImage(file);
}
