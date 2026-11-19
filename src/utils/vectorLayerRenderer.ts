import {
  CanvasDimensions,
  LayerItem,
  SpeechBalloon,
  TextLayerData,
} from '../types/editor';
import { computeMangaTextLayout, renderMangaTextToCanvas } from './mangaTextEngine';
import { hitTestBalloon, renderSpeechBalloon } from './balloonEngine';
import { SparseTileGrid, releaseTemporaryCanvas } from './tileEngine';

/**
 * Renders non-destructive TextLayerData onto a 2D canvas context.
 */
export function renderTextLayerData(
  ctx: CanvasRenderingContext2D,
  textData: TextLayerData
): void {
  if (!textData.text || !textData.text.trim()) return;
  renderMangaTextToCanvas(ctx, textData.text, textData.x, textData.y, {
    fontSize: textData.fontSize,
    fontFamily: textData.fontFamily,
    writingMode: textData.writingMode || 'horizontal-tb',
    bold: textData.bold,
    italic: textData.italic,
    align: textData.align,
    color: textData.color,
    outline: textData.outline,
    outlineColor: textData.outlineColor,
    outlineWidth: textData.outlineWidth,
    lineHeightRatio: textData.lineSpacing,
    anchorTopLeft: true,
  });
}

/**
 * Renders non-destructive SpeechBalloon onto a 2D canvas context.
 */
export function renderBalloonLayerData(
  ctx: CanvasRenderingContext2D,
  balloon: SpeechBalloon
): void {
  renderSpeechBalloon(ctx, balloon);
}

/**
 * Computes approximate hit-test bounding box for a non-destructive text layer in document coordinates.
 */
export function getTextLayerBounds(textData: TextLayerData): {
  x: number;
  y: number;
  width: number;
  height: number;
} {
  const layout = computeMangaTextLayout(textData.text || ' ', {
    fontSize: textData.fontSize,
    fontFamily: textData.fontFamily,
    writingMode: textData.writingMode || 'horizontal-tb',
    bold: textData.bold,
    italic: textData.italic,
    align: textData.align,
    lineHeightRatio: textData.lineSpacing,
    anchorTopLeft: true,
  });
  return {
    x: textData.x,
    y: textData.y,
    width: Math.max(24, layout.width + 16),
    height: Math.max(24, layout.height + 16),
  };
}

/**
 * Tests whether a canvas point hits a non-destructive text layer.
 */
export function hitTestTextLayer(
  textData: TextLayerData,
  pt: { x: number; y: number },
  padding = 12
): boolean {
  const b = getTextLayerBounds(textData);
  return (
    pt.x >= b.x - padding &&
    pt.x <= b.x + b.width + padding &&
    pt.y >= b.y - padding &&
    pt.y <= b.y + b.height + padding
  );
}

/**
 * Top-down hit test across all visible non-destructive text & balloon layers.
 */
export function hitTestEditableVectorLayer(
  layers: LayerItem[],
  pt: { x: number; y: number },
  isLayerVisible: (layer: LayerItem) => boolean,
  filterType?: 'text' | 'balloon'
): LayerItem | null {
  for (const layer of layers) {
    if (!isLayerVisible(layer) || layer.locked) continue;
    if (filterType && layer.type !== filterType) continue;
    if (layer.type === 'text' && layer.textData && hitTestTextLayer(layer.textData, pt)) {
      return layer;
    }
    if (layer.type === 'balloon' && layer.balloonData && hitTestBalloon(layer.balloonData, pt)) {
      return layer;
    }
  }
  return null;
}

/**
 * Re-renders a non-destructive text or balloon layer from its vector definition into
 * SparseTileGrid (and updates any materialized display canvas) without quality loss.
 */
export function syncVectorObjectLayerToGrid(
  layer: LayerItem,
  dimensions: CanvasDimensions,
  tileGrid: SparseTileGrid,
  layerCanvasesMap?: Map<string, HTMLCanvasElement>
): void {
  if (typeof document === 'undefined') return;
  if (layer.type !== 'text' && layer.type !== 'balloon') return;
  if (dimensions.width <= 0 || dimensions.height <= 0) return;

  const existingCanvas = layerCanvasesMap?.get(layer.id);
  const targetCanvas = existingCanvas ?? document.createElement('canvas');
  if (!existingCanvas) {
    targetCanvas.width = dimensions.width;
    targetCanvas.height = dimensions.height;
  }

  const ctx = targetCanvas.getContext('2d');
  if (!ctx) {
    if (!existingCanvas) releaseTemporaryCanvas(targetCanvas);
    return;
  }

  ctx.clearRect(0, 0, targetCanvas.width, targetCanvas.height);

  if (layer.type === 'text' && layer.textData) {
    renderTextLayerData(ctx, layer.textData);
  } else if (layer.type === 'balloon' && layer.balloonData) {
    renderBalloonLayerData(ctx, layer.balloonData);
  }

  const format = layer.expressionColor === 'monochrome' ? 'monochrome-1bit' : 'color-32bit';
  tileGrid.clearLayer(layer.id);
  tileGrid.ingestCanvas(layer.id, targetCanvas, format);
  tileGrid.notifyChange(true);

  if (!existingCanvas) {
    releaseTemporaryCanvas(targetCanvas);
  }
}
