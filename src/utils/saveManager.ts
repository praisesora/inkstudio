import type {
  BlendMode as AgPsdBlendMode,
  Layer as AgPsdLayer,
  LayerMaskData as AgPsdMaskData,
} from 'ag-psd';
import {
  CanvasDimensions,
  LayerItem,
  CanvasColorMode,
  BlendMode,
  isFolderLikeLayer,
  hasTileBackedLayer,
} from '../types/editor';
import { getCanvasCompositeOperation } from './canvasUtils';
import { buildLayerTree, groupTreeNodesForCompositing, LayerTreeNode } from './compositor';
import { applyAdjustment } from './tonalEngine';
import { applyMultiFrameClip, renderFrameBorder } from './frameEngine';
import { renderBalloonLayerData, renderTextLayerData } from './vectorLayerRenderer';
import { recoveryService } from '../services/recoveryService';
import { SparseTileGrid, TILE_SIZE, releaseTemporaryCanvas } from './tileEngine';
import { documentStore } from './documentStore';

export interface SavedFileInfo {
  handle?: any; // FileSystemFileHandle
  name: string;
  extension: string;
}

export interface SaveDocumentData {
  name: string;
  dimensions: CanvasDimensions;
  colorMode: CanvasColorMode;
  layers: LayerItem[];
  layerCanvasesMap: Map<string, HTMLCanvasElement>;
  tileGrid?: SparseTileGrid;
  getEffectiveOpacity: (layer: LayerItem) => number;
  isLayerEffectivelyVisible: (layer: LayerItem) => boolean;
  tabId?: string;
}

/**
 * Maps Ink Studio BlendMode to ag-psd BlendMode format.
 */
export function toAgPsdBlendMode(mode: BlendMode): AgPsdBlendMode {
  switch (mode) {
    case 'color-dodge':
    case 'color-dodge-glow':
      return 'color dodge';
    case 'color-burn':
      return 'color burn';
    case 'linear-burn':
      return 'linear burn';
    case 'add-glow':
      return 'linear dodge';
    case 'hard-light':
      return 'hard light';
    case 'soft-light':
      return 'soft light';
    case 'divide':
      return 'divide';
    case 'pass-through':
      return 'pass through';
    case 'normal':
    case 'multiply':
    case 'screen':
    case 'overlay':
    case 'darken':
    case 'lighten':
    case 'difference':
    case 'exclusion':
      return mode;
    default:
      return 'normal';
  }
}

function extractLayerMaskForPsd(layer: LayerItem): AgPsdMaskData | undefined {
  const maskCanvas = layer.maskCanvas;
  if (!maskCanvas || maskCanvas.width <= 0 || maskCanvas.height <= 0) {
    return undefined;
  }

  const mw = maskCanvas.width;
  const mh = maskCanvas.height;
  const maskMeta: AgPsdMaskData = {
    top: 0,
    left: 0,
    bottom: mh,
    right: mw,
    defaultColor: 255,
    disabled: layer.maskEnabled === false,
    positionRelativeToLayer: layer.maskLinked === false,
  };

  const ctx = maskCanvas.getContext('2d', { willReadFrequently: true });
  if (ctx && typeof ctx.getImageData === 'function') {
    const src = ctx.getImageData(0, 0, mw, mh).data;
    const out = new Uint8ClampedArray(mw * mh * 4);
    for (let i = 0; i < src.length; i += 4) {
      const lum = Math.round(((0.299 * src[i] + 0.587 * src[i + 1] + 0.114 * src[i + 2]) * src[i + 3]) / 255);
      out[i] = lum;
      out[i + 1] = lum;
      out[i + 2] = lum;
      out[i + 3] = 255;
    }
    maskMeta.imageData = { data: out, width: mw, height: mh };
  } else {
    maskMeta.canvas = maskCanvas;
  }

  return maskMeta;
}

function attachRasterPixelsForPsd(
  target: AgPsdLayer,
  layer: LayerItem,
  dimensions: CanvasDimensions,
  layerCanvasesMap: Map<string, HTMLCanvasElement>,
  tileGrid: SparseTileGrid | undefined,
  tempCanvases: HTMLCanvasElement[]
): void {
  // Prefer direct sparse tile bbox read when backed by SparseTileGrid (no full-size canvas allocation)
  const isVectorText =
    (layer.type === 'text' && Boolean(layer.textData)) ||
    (layer.type === 'balloon' && Boolean(layer.balloonData));

  if (!isVectorText && !layerCanvasesMap.has(layer.id) && tileGrid && tileGrid.hasLayerTiles(layer.id)) {
    const tiles = tileGrid.getLayerTiles(layer.id, 0);
    if (tiles.length === 0) return;

    let minX = dimensions.width;
    let minY = dimensions.height;
    let maxX = 0;
    let maxY = 0;
    for (const tile of tiles) {
      const tx0 = tile.tileX * TILE_SIZE;
      const ty0 = tile.tileY * TILE_SIZE;
      if (tx0 < minX) minX = tx0;
      if (ty0 < minY) minY = ty0;
      if (tx0 + TILE_SIZE > maxX) maxX = tx0 + TILE_SIZE;
      if (ty0 + TILE_SIZE > maxY) maxY = ty0 + TILE_SIZE;
    }
    const left = Math.max(0, minX);
    const top = Math.max(0, minY);
    const right = Math.min(dimensions.width, maxX);
    const bottom = Math.min(dimensions.height, maxY);
    if (left < right && top < bottom) {
      const imgData = tileGrid.readImageData(layer.id, left, top, right - left, bottom - top);
      target.left = left;
      target.top = top;
      target.right = right;
      target.bottom = bottom;
      target.imageData = imgData;
    }
    return;
  }

  const acq = acquireLayerExportCanvas(layer, dimensions, layerCanvasesMap, tileGrid);
  if (!acq.canvas) return;
  if (acq.isTemporary) tempCanvases.push(acq.canvas);

  const w = acq.canvas.width;
  const h = acq.canvas.height;
  if (w <= 0 || h <= 0) return;

  const ctx = acq.canvas.getContext('2d', { willReadFrequently: true });
  if (ctx && typeof ctx.getImageData === 'function') {
    const imgData = ctx.getImageData(0, 0, w, h);
    target.left = 0;
    target.top = 0;
    target.right = w;
    target.bottom = h;
    target.imageData = { data: imgData.data, width: w, height: h };
  } else {
    target.canvas = acq.canvas;
  }
}

function buildPsdLayerTree(
  nodes: LayerTreeNode[],
  dimensions: CanvasDimensions,
  layerCanvasesMap: Map<string, HTMLCanvasElement>,
  tileGrid: SparseTileGrid | undefined,
  tempCanvases: HTMLCanvasElement[]
): AgPsdLayer[] {
  const result: AgPsdLayer[] = [];

  // ag-psd expects bottom-to-top order; Ink Studio layer tree is top-to-bottom
  for (let i = nodes.length - 1; i >= 0; i--) {
    const node = nodes[i];
    const layer = node.layer;
    const isFolder = isFolderLikeLayer(layer);
    if (!isFolder && !hasTileBackedLayer(layer)) continue;

    const psdLayer: AgPsdLayer = {
      name: layer.name,
      hidden: !layer.visible,
      opacity: Math.max(0, Math.min(1, layer.opacity ?? 1)),
      blendMode: toAgPsdBlendMode(layer.blendMode),
    };

    if (layer.clipped) {
      psdLayer.clipping = true;
    }

    if (layer.alphaLocked || layer.locked) {
      psdLayer.protected = {
        transparency: Boolean(layer.alphaLocked),
        composite: Boolean(layer.locked),
        position: Boolean(layer.locked),
      };
      if (layer.alphaLocked) {
        psdLayer.transparencyProtected = true;
      }
    }

    const mask = extractLayerMaskForPsd(layer);
    if (mask) {
      psdLayer.mask = mask;
    }

    if (isFolder) {
      psdLayer.opened = !layer.collapsed;
      psdLayer.children = buildPsdLayerTree(
        node.children,
        dimensions,
        layerCanvasesMap,
        tileGrid,
        tempCanvases
      );
    } else {
      attachRasterPixelsForPsd(
        psdLayer,
        layer,
        dimensions,
        layerCanvasesMap,
        tileGrid,
        tempCanvases
      );
    }

    result.push(psdLayer);
  }

  return result;
}

/**
 * Resolves a layer's canvas from either the map or temporarily from SparseTileGrid.
 * Returns `{ canvas, isTemporary }` so caller immediately releases temporary canvases.
 */
function acquireLayerExportCanvas(
  layer: LayerItem,
  dimensions: CanvasDimensions,
  layerCanvasesMap: Map<string, HTMLCanvasElement>,
  tileGrid?: SparseTileGrid
): { canvas: HTMLCanvasElement | null; isTemporary: boolean } {
  // Always render non-destructive text/balloon layers crisply from vector metadata when available
  if (layer.type === 'text' && layer.textData && typeof document !== 'undefined') {
    const temp = document.createElement('canvas');
    temp.width = dimensions.width;
    temp.height = dimensions.height;
    const ctx = temp.getContext('2d');
    if (ctx) renderTextLayerData(ctx, layer.textData);
    return { canvas: temp, isTemporary: true };
  }
  if (layer.type === 'balloon' && layer.balloonData && typeof document !== 'undefined') {
    const temp = document.createElement('canvas');
    temp.width = dimensions.width;
    temp.height = dimensions.height;
    const ctx = temp.getContext('2d');
    if (ctx) renderBalloonLayerData(ctx, layer.balloonData);
    return { canvas: temp, isTemporary: true };
  }
  const existing = layerCanvasesMap.get(layer.id);
  if (existing) {
    return { canvas: existing, isTemporary: false };
  }
  if (tileGrid && tileGrid.hasLayerTiles(layer.id)) {
    const temp = tileGrid.exportLayerToCanvas(layer.id, dimensions.width, dimensions.height);
    return { canvas: temp, isTemporary: true };
  }
  return { canvas: null, isTemporary: false };
}

/**
 * Composites all visible layers with their blend modes, opacities, frame-folder polygon clipping,
 * and non-destructive vector text/balloon layers onto a single canvas.
 */
export function compositeCanvas(
  dimensions: CanvasDimensions,
  layers: LayerItem[],
  layerCanvasesMap: Map<string, HTMLCanvasElement>,
  getEffectiveOpacity: (layer: LayerItem) => number,
  isLayerEffectivelyVisible: (layer: LayerItem) => boolean,
  fillWhiteBackground: boolean = false,
  tileGrid?: SparseTileGrid
): HTMLCanvasElement {
  const exportCanvas = document.createElement('canvas');
  exportCanvas.width = dimensions.width;
  exportCanvas.height = dimensions.height;
  const ctx = exportCanvas.getContext('2d');
  if (!ctx) return exportCanvas;

  if (fillWhiteBackground) {
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, dimensions.width, dimensions.height);
  }

  const getMaskedLayerCanvas = (
    layer: LayerItem,
    srcCanvas: HTMLCanvasElement
  ): { canvas: HTMLCanvasElement; isTemporary: boolean } => {
    if (!layer.maskCanvas || layer.maskEnabled === false) {
      return { canvas: srcCanvas, isTemporary: false };
    }
    const masked = document.createElement('canvas');
    masked.width = dimensions.width;
    masked.height = dimensions.height;
    const mCtx = masked.getContext('2d');
    const maskCtx = layer.maskCanvas.getContext('2d', { willReadFrequently: true });
    if (!mCtx || !maskCtx) {
      releaseTemporaryCanvas(masked);
      return { canvas: srcCanvas, isTemporary: false };
    }
    mCtx.drawImage(srcCanvas, 0, 0);
    const imgData = mCtx.getImageData(0, 0, dimensions.width, dimensions.height);
    const maskData = maskCtx.getImageData(0, 0, dimensions.width, dimensions.height).data;
    const d = imgData.data;
    for (let i = 0; i < d.length; i += 4) {
      if (d[i + 3] === 0) continue;
      const maskLum = ((0.299 * maskData[i] + 0.587 * maskData[i + 1] + 0.114 * maskData[i + 2]) / 255) * (maskData[i + 3] / 255);
      d[i + 3] = Math.round(d[i + 3] * maskLum);
    }
    mCtx.putImageData(imgData, 0, 0);
    return { canvas: masked, isTemporary: true };
  };

  const renderTreeNodes = (
    targetCtx: CanvasRenderingContext2D,
    nodes: LayerTreeNode[],
    opacityMul: number
  ) => {
    const renderOrder = nodes.slice().reverse();
    const groups = groupTreeNodesForCompositing(renderOrder);

    for (const group of groups) {
      const baseNode = group.baseNode;
      const baseLayer = baseNode.layer;
      if (!baseLayer.visible || baseLayer.opacity <= 0.001) continue;

      if (baseLayer.type === 'frame-folder') {
        const folderAlpha = opacityMul * baseLayer.opacity;
        const frames = (baseLayer.comicFrames || []).filter((f) => f.polygon.length >= 3);
        const shouldClip = frames.length > 0 && frames.some((f) => f.clipChildren !== false);
        const folderCanvas = document.createElement('canvas');
        folderCanvas.width = dimensions.width;
        folderCanvas.height = dimensions.height;
        const fCtx = folderCanvas.getContext('2d');
        if (fCtx) {
          fCtx.save();
          if (shouldClip) {
            applyMultiFrameClip(fCtx, frames);
          }
          for (const frame of frames) {
            if (frame.fillBackground !== false) {
              fCtx.fillStyle = frame.fillColor || '#ffffff';
              fCtx.beginPath();
              fCtx.moveTo(frame.polygon[0].x, frame.polygon[0].y);
              for (let i = 1; i < frame.polygon.length; i++) {
                fCtx.lineTo(frame.polygon[i].x, frame.polygon[i].y);
              }
              fCtx.closePath();
              fCtx.fill();
            }
          }
          if (baseNode.children.length > 0) {
            renderTreeNodes(fCtx, baseNode.children, 1.0);
          }
          fCtx.restore();
          for (const frame of frames) {
            renderFrameBorder(fCtx, frame, false);
          }
          targetCtx.save();
          targetCtx.globalAlpha = Math.max(0, Math.min(1, folderAlpha));
          const blend = baseLayer.blendMode === 'pass-through' ? 'normal' : baseLayer.blendMode;
          targetCtx.globalCompositeOperation = getCanvasCompositeOperation(blend);
          targetCtx.drawImage(folderCanvas, 0, 0);
          targetCtx.restore();
        }
        releaseTemporaryCanvas(folderCanvas);
        continue;
      }

      if (baseLayer.type === 'folder') {
        const folderAlpha = opacityMul * baseLayer.opacity;
        if (baseLayer.blendMode === 'pass-through') {
          if (baseNode.children.length > 0) {
            renderTreeNodes(targetCtx, baseNode.children, folderAlpha);
          }
        } else {
          const folderCanvas = document.createElement('canvas');
          folderCanvas.width = dimensions.width;
          folderCanvas.height = dimensions.height;
          const fCtx = folderCanvas.getContext('2d');
          if (fCtx) {
            if (baseNode.children.length > 0) {
              renderTreeNodes(fCtx, baseNode.children, 1.0);
            }
            targetCtx.save();
            targetCtx.globalAlpha = Math.max(0, Math.min(1, folderAlpha));
            targetCtx.globalCompositeOperation = getCanvasCompositeOperation(baseLayer.blendMode);
            targetCtx.drawImage(folderCanvas, 0, 0);
            targetCtx.restore();
          }
          releaseTemporaryCanvas(folderCanvas);
        }
        continue;
      }

      if (!isLayerEffectivelyVisible(baseLayer)) continue;

      if (baseLayer.type === 'adjustment' && baseLayer.adjustmentData) {
        const imgData = targetCtx.getImageData(0, 0, dimensions.width, dimensions.height);
        applyAdjustment(
          imgData,
          baseLayer.adjustmentData,
          baseLayer.maskEnabled !== false ? baseLayer.maskCanvas : undefined,
          baseLayer.opacity * opacityMul
        );
        targetCtx.putImageData(imgData, 0, 0);
        continue;
      }

      const baseAcq = acquireLayerExportCanvas(baseLayer, dimensions, layerCanvasesMap, tileGrid);
      if (!baseAcq.canvas) continue;
      const maskedBase = getMaskedLayerCanvas(baseLayer, baseAcq.canvas);

      const activeClipped = group.clippedNodes
        .map((n) => n.layer)
        .filter((cl) => !isFolderLikeLayer(cl) && cl.type !== 'adjustment' && cl.visible && cl.opacity > 0.001);

      if (activeClipped.length === 0) {
        targetCtx.save();
        targetCtx.globalAlpha = Math.max(0, Math.min(1, baseLayer.opacity * opacityMul));
        targetCtx.globalCompositeOperation = getCanvasCompositeOperation(baseLayer.blendMode);
        targetCtx.drawImage(maskedBase.canvas, 0, 0);
        targetCtx.restore();
      } else {
        const groupCanvas = document.createElement('canvas');
        groupCanvas.width = dimensions.width;
        groupCanvas.height = dimensions.height;
        const gCtx = groupCanvas.getContext('2d');
        if (gCtx) {
          gCtx.save();
          gCtx.globalAlpha = Math.max(0, Math.min(1, baseLayer.opacity * opacityMul));
          gCtx.drawImage(maskedBase.canvas, 0, 0);
          gCtx.restore();

          for (const clipped of activeClipped) {
            const clipAcq = acquireLayerExportCanvas(clipped, dimensions, layerCanvasesMap, tileGrid);
            if (!clipAcq.canvas) continue;
            const maskedClip = getMaskedLayerCanvas(clipped, clipAcq.canvas);

            gCtx.save();
            gCtx.globalAlpha = Math.max(0, Math.min(1, clipped.opacity * opacityMul));
            gCtx.globalCompositeOperation = 'source-atop';
            gCtx.drawImage(maskedClip.canvas, 0, 0);
            gCtx.restore();

            if (maskedClip.isTemporary) releaseTemporaryCanvas(maskedClip.canvas);
            if (clipAcq.isTemporary) releaseTemporaryCanvas(clipAcq.canvas);
          }

          targetCtx.save();
          targetCtx.globalAlpha = 1.0;
          targetCtx.globalCompositeOperation = getCanvasCompositeOperation(baseLayer.blendMode);
          targetCtx.drawImage(groupCanvas, 0, 0);
          targetCtx.restore();
        }
        releaseTemporaryCanvas(groupCanvas);
      }

      if (maskedBase.isTemporary) releaseTemporaryCanvas(maskedBase.canvas);
      if (baseAcq.isTemporary) releaseTemporaryCanvas(baseAcq.canvas);
    }
  };

  const tree = buildLayerTree(layers);
  renderTreeNodes(ctx, tree, 1.0);
  void getEffectiveOpacity;

  return exportCanvas;
}

/**
 * Converts a canvas element into a Blob with the specified mime-type.
 */
export function canvasToBlob(
  canvas: HTMLCanvasElement,
  mimeType: string = 'image/png',
  quality?: number
): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => {
        if (blob) resolve(blob);
        else reject(new Error('Canvas toBlob failed'));
      },
      mimeType,
      quality
    );
  });
}

export interface SerializedSoraProject {
  app: string;
  version: string;
  name: string;
  dimensions: CanvasDimensions;
  colorMode: CanvasColorMode;
  layers: Array<Omit<LayerItem, 'maskCanvas'>>;
  canvases: Record<string, string>;
  masks: Record<string, string>;
}

/**
 * Pure serializer for native `.sora` / `.ink` project JSON, preserving non-destructive
 * text, speech balloon, vector, adjustment, and frame-folder metadata.
 */
export function buildSoraProjectPayload(
  data: SaveDocumentData,
  tileGrid?: SparseTileGrid
): SerializedSoraProject {
  const layerImages: Record<string, string> = {};
  const maskImages: Record<string, string> = {};
  const serializableLayers = data.layers.map((l) => {
    if (hasTileBackedLayer(l)) {
      const acq = acquireLayerExportCanvas(l, data.dimensions, data.layerCanvasesMap, tileGrid);
      if (acq.canvas && typeof acq.canvas.toDataURL === 'function') {
        layerImages[l.id] = acq.canvas.toDataURL('image/png');
        if (acq.isTemporary) releaseTemporaryCanvas(acq.canvas);
      }
    }
    if (l.maskCanvas && typeof l.maskCanvas.toDataURL === 'function') {
      maskImages[l.id] = l.maskCanvas.toDataURL('image/png');
    }
    const { maskCanvas: _mc, ...rest } = l;
    return rest;
  });

  return {
    app: 'Ink Studio',
    version: '1.2',
    name: data.name,
    dimensions: data.dimensions,
    colorMode: data.colorMode,
    layers: serializableLayers,
    canvases: layerImages,
    masks: maskImages,
  };
}

/**
 * Pure parser for `.sora` / `.ink` JSON strings validating structural integrity
 * and restoring non-destructive text, balloon, and frame-folder layer metadata.
 */
export function parseSoraProjectJson(jsonText: string): SerializedSoraProject {
  const parsed = JSON.parse(jsonText);
  if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.layers)) {
    throw new Error('Invalid .sora project payload: missing layers array');
  }
  const layers = parsed.layers.map((l: any) => {
    const clean = { ...l };
    if (clean.maskCanvas && typeof clean.maskCanvas.getContext !== 'function') {
      clean.maskCanvas = undefined;
    }
    return clean;
  });
  return {
    app: typeof parsed.app === 'string' ? parsed.app : 'Ink Studio',
    version: typeof parsed.version === 'string' ? parsed.version : '1.0',
    name: typeof parsed.name === 'string' ? parsed.name : 'Untitled',
    dimensions: {
      width: Number(parsed.dimensions?.width) || 1440,
      height: Number(parsed.dimensions?.height) || 900,
      dpi: Number(parsed.dimensions?.dpi) || 300,
    },
    colorMode: parsed.colorMode || 'color',
    layers,
    canvases: parsed.canvases && typeof parsed.canvases === 'object' ? parsed.canvases : {},
    masks: parsed.masks && typeof parsed.masks === 'object' ? parsed.masks : {},
  };
}

/**
 * Serializes the document according to the requested file extension.
 */
export async function serializeDocument(
  data: SaveDocumentData,
  extension: string
): Promise<{ data: Blob | ArrayBuffer; mimeType: string }> {
  const ext = extension.toLowerCase();
  const tileGrid = data.tileGrid ?? (data.tabId ? documentStore.getSession(data.tabId)?.tileGrid : documentStore.getActiveTileGrid());

  // 1. PSD/PSB format with full folder hierarchy, blend modes, clipping, alphaLock, and masks
  if (ext === '.psd' || ext === '.psb') {
    const tempCanvases: HTMLCanvasElement[] = [];
    try {
      const tree = buildLayerTree(data.layers);
      const children = buildPsdLayerTree(
        tree,
        data.dimensions,
        data.layerCanvasesMap,
        tileGrid,
        tempCanvases
      );

      const dpi = data.dimensions.dpi || 300;
      const { writePsd } = await import('ag-psd');
      const psdBuffer = writePsd(
        {
          width: data.dimensions.width,
          height: data.dimensions.height,
          children,
          imageResources: {
            resolutionInfo: {
              horizontalResolution: dpi,
              horizontalResolutionUnit: 'PPI',
              widthUnit: 'Inches',
              verticalResolution: dpi,
              verticalResolutionUnit: 'PPI',
              heightUnit: 'Inches',
            },
          },
        },
        {
          psb: ext === '.psb',
          noBackground: true,
        }
      );

      return {
        data: psdBuffer,
        mimeType: 'image/vnd.adobe.photoshop',
      };
    } finally {
      for (const temp of tempCanvases) {
        releaseTemporaryCanvas(temp);
      }
    }
  }

  // 2. Native Ink Studio Project (.ink, .sora) format
  if (ext === '.ink' || ext === '.sora') {
    const projectData = buildSoraProjectPayload(data, tileGrid);
    const json = JSON.stringify(projectData);
    return {
      data: new Blob([json], { type: 'application/json' }),
      mimeType: 'application/json',
    };
  }

  // 3. JPEG format
  if (ext === '.jpg' || ext === '.jpeg') {
    const compCanvas = compositeCanvas(
      data.dimensions,
      data.layers,
      data.layerCanvasesMap,
      data.getEffectiveOpacity,
      data.isLayerEffectivelyVisible,
      true, // white background for JPEG
      tileGrid
    );
    try {
      const blob = await canvasToBlob(compCanvas, 'image/jpeg', 0.92);
      return { data: blob, mimeType: 'image/jpeg' };
    } finally {
      releaseTemporaryCanvas(compCanvas);
    }
  }

  // 4. WebP format
  if (ext === '.webp') {
    const compCanvas = compositeCanvas(
      data.dimensions,
      data.layers,
      data.layerCanvasesMap,
      data.getEffectiveOpacity,
      data.isLayerEffectivelyVisible,
      false,
      tileGrid
    );
    try {
      const blob = await canvasToBlob(compCanvas, 'image/webp', 0.92);
      return { data: blob, mimeType: 'image/webp' };
    } finally {
      releaseTemporaryCanvas(compCanvas);
    }
  }

  // 5. Default: PNG format
  const compCanvas = compositeCanvas(
    data.dimensions,
    data.layers,
    data.layerCanvasesMap,
    data.getEffectiveOpacity,
    data.isLayerEffectivelyVisible,
    false,
    tileGrid
  );
  try {
    const blob = await canvasToBlob(compCanvas, 'image/png');
    return { data: blob, mimeType: 'image/png' };
  } finally {
    releaseTemporaryCanvas(compCanvas);
  }
}

/**
 * Triggers fallback download using standard anchor element.
 */
export function downloadFile(
  content: Blob | ArrayBuffer,
  fileName: string,
  mimeType: string
) {
  const blob = content instanceof Blob ? content : new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => {
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }, 200);
}

/**
 * Prompts user to select save location and extension via File System Access API or fallback.
 */
export async function promptSaveAs(
  data: SaveDocumentData,
  defaultExtension: string = '.sora',
  fallbackToDownload: boolean = true
): Promise<SavedFileInfo> {
  const safeName = data.name.trim().replace(/[^a-zA-Z0-9_\- ]/g, '_') || 'Untitled';
  const suggestedName = `${safeName}${defaultExtension}`;

  const types = [
    {
      description: 'Ink Studio Layered Project (*.sora, *.ink)',
      accept: { 'application/json': ['.sora', '.ink'] },
    },
    {
      description: 'Photoshop Document with Layers (*.psd)',
      accept: { 'image/vnd.adobe.photoshop': ['.psd'] },
    },
    {
      description: 'PNG Image (*.png)',
      accept: { 'image/png': ['.png'] },
    },
    {
      description: 'JPEG Image (*.jpg, *.jpeg)',
      accept: { 'image/jpeg': ['.jpg', '.jpeg'] },
    },
    {
      description: 'WebP Image (*.webp)',
      accept: { 'image/webp': ['.webp'] },
    },
  ];

  if (typeof window !== 'undefined' && 'showSaveFilePicker' in window) {
    try {
      const handle = await (window as any).showSaveFilePicker({
        suggestedName,
        types,
      });

      const fileName = handle.name;
      const ext = fileName.includes('.')
        ? fileName.slice(fileName.lastIndexOf('.')).toLowerCase()
        : defaultExtension;

      const serialized = await serializeDocument(data, ext);
      const writable = await handle.createWritable();
      await writable.write(serialized.data);
      await writable.close();

      if (data.tabId) {
        recoveryService.markCleanSaved(data.tabId).catch(console.warn);
      }

      return {
        handle,
        name: fileName,
        extension: ext,
      };
    } catch (err: any) {
      if (err.name === 'AbortError') {
        throw new Error('Save canceled');
      }
      console.warn('showSaveFilePicker failed or unsupported, using download fallback:', err);
    }
  }

  // Fallback if File System Access API is unavailable or rejected
  if (fallbackToDownload) {
    const ext = defaultExtension;
    const serialized = await serializeDocument(data, ext);
    downloadFile(serialized.data, suggestedName, serialized.mimeType);

    if (data.tabId) {
      recoveryService.markCleanSaved(data.tabId).catch(console.warn);
    }

    return {
      name: suggestedName,
      extension: ext,
    };
  }

  throw new Error('Save dialog was not available');
}

/**
 * Writes directly to an already selected FileSystemFileHandle without prompting.
 */
export async function saveToExistingHandle(
  data: SaveDocumentData,
  fileInfo: SavedFileInfo
): Promise<void> {
  if (!fileInfo.handle || typeof fileInfo.handle.createWritable !== 'function') {
    throw new Error('No valid file handle to save to');
  }

  const serialized = await serializeDocument(data, fileInfo.extension);
  const writable = await fileInfo.handle.createWritable();
  await writable.write(serialized.data);
  await writable.close();

  if (data.tabId) {
    recoveryService.markCleanSaved(data.tabId).catch(console.warn);
  }
}

/**
 * Prompts user to choose a download/save path specifically for a PNG image.
 */
export async function promptExportPngImage(
  data: SaveDocumentData,
  defaultName?: string
): Promise<string> {
  const safeName = (defaultName || data.name || 'artwork').trim().replace(/[^a-zA-Z0-9_\- ]/g, '_');
  const suggestedName = `${safeName}.png`;

  const types = [
    {
      description: 'PNG Image (*.png)',
      accept: { 'image/png': ['.png'] },
    },
  ];

  if (typeof window !== 'undefined' && 'showSaveFilePicker' in window) {
    try {
      const handle = await (window as any).showSaveFilePicker({
        suggestedName,
        types,
      });

      const serialized = await serializeDocument(data, '.png');
      const writable = await handle.createWritable();
      await writable.write(serialized.data);
      await writable.close();

      return handle.name;
    } catch (err: any) {
      if (err.name === 'AbortError') {
        throw new Error('Export canceled');
      }
      console.warn('showSaveFilePicker failed for export, falling back to download:', err);
    }
  }

  // Fallback download
  const serialized = await serializeDocument(data, '.png');
  downloadFile(serialized.data, suggestedName, 'image/png');
  return suggestedName;
}
