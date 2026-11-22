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
 * SparseTileGrid using a tight bounding-box scratch canvas (zero full-doc canvas allocation).
 */
export function syncVectorObjectLayerToGrid(
  layer: LayerItem,
  dimensions: CanvasDimensions,
  tileGrid: SparseTileGrid
): void {
  if (typeof document === 'undefined') return;
  if (layer.type !== 'text' && layer.type !== 'balloon') return;
  if (dimensions.width <= 0 || dimensions.height <= 0) return;

  let minX = 0;
  let minY = 0;
  let maxX = dimensions.width;
  let maxY = dimensions.height;

  if (layer.type === 'text' && layer.textData) {
    const b = getTextLayerBounds(layer.textData);
    const pad = Math.ceil(Math.max(32, (layer.textData.outlineWidth ?? 0) * 4 + layer.textData.fontSize));
    minX = Math.max(0, Math.floor(b.x - pad));
    minY = Math.max(0, Math.floor(b.y - pad));
    maxX = Math.min(dimensions.width, Math.ceil(b.x + b.width + pad));
    maxY = Math.min(dimensions.height, Math.ceil(b.y + b.height + pad));
  } else if (layer.type === 'balloon' && layer.balloonData) {
    const bd = layer.balloonData;
    const flashExtra =
      bd.shape === 'jagged-flash' ? Math.max(bd.bounds.width, bd.bounds.height) * 0.25 : 0;
    const pad = Math.ceil(
      Math.max(48, (bd.strokeWidth ?? 3) * 4 + (bd.fontSize ?? 24) * 2 + flashExtra)
    );
    let bx0 = bd.bounds.x;
    let by0 = bd.bounds.y;
    let bx1 = bd.bounds.x + bd.bounds.width;
    let by1 = bd.bounds.y + bd.bounds.height;
    if (bd.tail) {
      const pts = [bd.tail.start, bd.tail.control1, bd.tail.control2, bd.tail.tip];
      for (const p of pts) {
        if (!p) continue;
        bx0 = Math.min(bx0, p.x);
        by0 = Math.min(by0, p.y);
        bx1 = Math.max(bx1, p.x);
        by1 = Math.max(by1, p.y);
      }
    }
    minX = Math.max(0, Math.floor(bx0 - pad));
    minY = Math.max(0, Math.floor(by0 - pad));
    maxX = Math.min(dimensions.width, Math.ceil(bx1 + pad));
    maxY = Math.min(dimensions.height, Math.ceil(by1 + pad));
  }

  const rw = maxX - minX;
  const rh = maxY - minY;
  const format = layer.expressionColor === 'monochrome' ? 'monochrome-1bit' : 'color-32bit';
  tileGrid.clearLayer(layer.id);
  tileGrid.setLayerFormat(layer.id, format);
  tileGrid.markLayerIngested(layer.id);

  if (rw <= 0 || rh <= 0) {
    tileGrid.notifyChange(true);
    return;
  }

  const targetCanvas = document.createElement('canvas');
  targetCanvas.width = rw;
  targetCanvas.height = rh;
  const ctx = targetCanvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) {
    releaseTemporaryCanvas(targetCanvas);
    return;
  }

  ctx.save();
  ctx.translate(-minX, -minY);
  if (layer.type === 'text' && layer.textData) {
    renderTextLayerData(ctx, layer.textData);
  } else if (layer.type === 'balloon' && layer.balloonData) {
    renderBalloonLayerData(ctx, layer.balloonData);
  }
  ctx.restore();

  const imgData = ctx.getImageData(0, 0, rw, rh);
  tileGrid.writeImageData(layer.id, imgData, minX, minY, format, true);
  tileGrid.notifyChange(true);
  releaseTemporaryCanvas(targetCanvas);
}
