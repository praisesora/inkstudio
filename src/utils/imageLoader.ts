import { LoadedDocument, LayerItem, CanvasColorMode } from '../types/editor';
import { renderVectorLayer } from './vectorEngine';
import { renderBalloonLayerData, renderTextLayerData } from './vectorLayerRenderer';
import { PRIMARY_PROJECT_EXTENSION, parseInkProject } from './saveManager';
import { SparseTileGrid, releaseTemporaryCanvas } from './tileEngine';

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
        const bgId = `layer-bg-${Date.now()}`;
        const grid = new SparseTileGrid();

        const tempCanvas = document.createElement('canvas');
        tempCanvas.width = width;
        tempCanvas.height = height;
        const ctx = tempCanvas.getContext('2d');
        if (ctx) {
          ctx.drawImage(img, 0, 0);
        }
        grid.ingestCanvas(layerId, tempCanvas, 'color-32bit');
        releaseTemporaryCanvas(tempCanvas);

        grid.fillLayerSolidWhite(bgId, width, height, 'color-32bit');

        const thumb = grid.generateThumbnail(layerId, 64, 64, { width, height }, true);
        const bgThumb = grid.generateThumbnail(bgId, 64, 64, { width, height }, false);

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
          tileGrid: grid,
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
 * Universal file opener detecting file extension and loading native `.ink`, legacy `.sora`
 * (via read-only migrator), PSD, CSP, or standard image files.
 */
export async function openFile(file: File): Promise<LoadedDocument> {
  const dot = file.name.lastIndexOf('.');
  const ext = dot >= 0 ? file.name.slice(dot).toLowerCase() : '';

  if (ext === '.psd' || ext === '.psb') {
    const { parsePsdFile } = await import('./psdParser');
    const buffer = await file.arrayBuffer();
    return await parsePsdFile(buffer, file.name);
  }

  if (ext === '.clip' || ext === '.csp' || ext === '.lip') {
    const { parseCspFile } = await import('./cspParser');
    const buffer = await file.arrayBuffer();
    return await parseCspFile(buffer, file.name);
  }

  if (ext === PRIMARY_PROJECT_EXTENSION) {
    const buffer = await file.arrayBuffer();
    const project = await parseInkProject(buffer);
    const { width, height } = project.dimensions;
    const dpi = project.dimensions.dpi || 300;
    const colorMode: CanvasColorMode = project.colorMode || 'color';
    const layers = project.layers;
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
      workTimeMs: project.workTimeMs,
      previewDataUrl: project.previewDataUrl,
    };
  }

  // Legacy `.sora` files are routed exclusively to the read-only migrator
  if (ext === '.sora') {
    const { migrateLegacySoraFile } = await import('./legacySoraMigrator');
    return await migrateLegacySoraFile(file);
  }

  // Common image extensions: .png, .jpg, .jpeg, .webp, .bmp, .gif, .svg
  return await loadStandardImage(file);
}
