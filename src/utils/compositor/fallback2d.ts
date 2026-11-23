import { CanvasDimensions, LayerItem, isFolderLikeLayer, resolveToneDensityType } from '../../types/editor';
import { getCanvasCompositeOperation } from '../canvasUtils';
import { applyMultiFrameClip, renderFrameBorder } from '../frameEngine';
import { applyScreentoneCPU } from '../screentoneEngine';
import { SparseTileGrid, TILE_SIZE, TileBuffer } from '../tileEngine';
import { applyAdjustment } from '../tonalEngine';
import { calculateVisibleDocumentBounds } from './bounds';
import { buildLayerTree, groupTreeNodesForCompositing } from './layerTree';
import { hasActiveLayerStyles } from './shaders/effectShaders';
import {
  CompositorOptions,
  CompositorState,
  DocumentBounds,
  LayerTreeNode,
  ViewportTransform,
} from './types';

function collectVisible2DTiles(
  grid: SparseTileGrid,
  layerId: string,
  zoom: number,
  frustum?: DocumentBounds | null
): { tiles: TileBuffer[]; lodTileDocSize: number } {
  const targetLod =
    !frustum
      ? 0
      : zoom <= 0.125
        ? 3
        : zoom <= 0.25
          ? 2
          : zoom <= 0.5
            ? 1
            : 0;
  const lodScale = 1 << targetLod;
  const lodTileDocSize = TILE_SIZE * lodScale;

  if (!frustum) {
    return { tiles: grid.getLayerTiles(layerId, 0), lodTileDocSize: TILE_SIZE };
  }

  const hasLayerTiles =
    typeof grid.hasLayerTiles === 'function' ? grid.hasLayerTiles(layerId) : true;
  if (!hasLayerTiles) {
    return { tiles: [], lodTileDocSize };
  }

  const hasOccCheck = typeof grid.hasPopulatedLodTile === 'function';
  const startTileX = Math.floor(frustum.minX / lodTileDocSize);
  const endTileX = Math.floor(frustum.maxX / lodTileDocSize);
  const startTileY = Math.floor(frustum.minY / lodTileDocSize);
  const endTileY = Math.floor(frustum.maxY / lodTileDocSize);

  const visibleTiles: TileBuffer[] = [];
  for (let ty = startTileY; ty <= endTileY; ty++) {
    for (let tx = startTileX; tx <= endTileX; tx++) {
      if (targetLod > 0 && hasOccCheck && !grid.hasPopulatedLodTile(layerId, tx, ty, targetLod)) {
        continue;
      }
      let tile = grid.getTile(layerId, tx, ty, targetLod);
      if (
        targetLod > 0 &&
        (!tile || tile.data === null || grid.isLodTileDirty(layerId, tx, ty, targetLod))
      ) {
        tile = grid.generateLodTile(layerId, tx, ty, targetLod);
      }
      if (tile) {
        visibleTiles.push(tile);
      }
    }
  }
  return { tiles: visibleTiles, lodTileDocSize };
}

function getReusableTileImageData(
  state: CompositorState,
  tileCtx: CanvasRenderingContext2D
): ImageData {
  if (!state.fallbackTileImageData) {
    state.fallbackTileImageData = tileCtx.createImageData(TILE_SIZE, TILE_SIZE);
  }
  return state.fallbackTileImageData;
}

/**
 * Helper to render a single layer onto a 2D canvas context.
 */
export function render2DSingleLayer(
  state: CompositorState,
  targetCtx: CanvasRenderingContext2D,
  layer: LayerItem,
  grid: SparseTileGrid,
  tileCtx: CanvasRenderingContext2D | null | undefined,
  opacityMultiplier: number = 1.0,
  frustum?: DocumentBounds | null
): void {
  targetCtx.save();
  const effectiveOpacity = Math.max(0, Math.min(1, layer.opacity * opacityMultiplier));
  const toneEnabled = Boolean(layer.toneEnabled);
  const toneDensityType = resolveToneDensityType(layer);
  const toneDpi = state.currentOptions?.dimensions?.dpi ?? 600;
  const toneSpecifiedDensity = Math.max(0, Math.min(1, (layer.toneDensity ?? 40) / 100));

  if ((toneEnabled || layer.expressionColor === 'monochrome') && state.currentZoom >= 0.99) {
    targetCtx.imageSmoothingEnabled = false;
  }

  targetCtx.globalAlpha = effectiveOpacity;
  targetCtx.globalCompositeOperation = getCanvasCompositeOperation(layer.blendMode);

  const { tiles, lodTileDocSize } = collectVisible2DTiles(
    grid,
    layer.id,
    state.currentZoom,
    frustum
  );
  const hasMask = Boolean(layer.maskCanvas && layer.maskEnabled !== false);
  const maskCtx = hasMask && layer.maskCanvas ? layer.maskCanvas.getContext('2d', { willReadFrequently: true }) : null;

  // Helper to render tiles into target context (reuses single ImageData buffer — zero per-tile GC)
  const drawTiles = (ctx: CanvasRenderingContext2D) => {
    if (!tileCtx || !state.fallbackTileCanvas) return;
    const imgData = getReusableTileImageData(state, tileCtx);
    const scaleRatio = lodTileDocSize / TILE_SIZE;
    const renderCrispTone = toneEnabled && scaleRatio === 1;
    const prevAlpha = ctx.globalAlpha;
    if (toneEnabled) {
      ctx.globalAlpha = renderCrispTone
        ? 1.0
        : toneDensityType === 'specified'
          ? Math.max(0, Math.min(1, effectiveOpacity * toneSpecifiedDensity))
          : effectiveOpacity;
    }

    for (const tile of tiles) {
      const rgba = grid.getTileAsRGBA(tile);
      imgData.data.set(rgba);

      if (hasMask && maskCtx && scaleRatio === 1) {
        const maskImgData = maskCtx.getImageData(tile.tileX * TILE_SIZE, tile.tileY * TILE_SIZE, TILE_SIZE, TILE_SIZE);
        const md = maskImgData.data;
        const d = imgData.data;
        for (let i = 0; i < d.length; i += 4) {
          if (d[i + 3] === 0) continue;
          const maskLum = (0.299 * md[i] + 0.587 * md[i + 1] + 0.114 * md[i + 2]) / 255 * (md[i + 3] / 255);
          d[i + 3] = Math.round(d[i + 3] * maskLum);
        }
      }

      if (renderCrispTone && toneDensityType === 'image' && effectiveOpacity < 0.999) {
        const d = imgData.data;
        for (let i = 3; i < d.length; i += 4) {
          if (d[i] > 0) d[i] = Math.round(d[i] * effectiveOpacity);
        }
      }

      tileCtx.putImageData(imgData, 0, 0);

      if (renderCrispTone) {
        applyScreentoneCPU(state.fallbackTileCanvas, state.fallbackTileCanvas, {
          frequency: layer.toneFrequency ?? 60,
          angle: layer.toneAngle ?? 45,
          dotShape: layer.toneDotShape ?? 'circle',
          dpi: toneDpi,
          densityType: toneDensityType,
          specifiedDensity: toneSpecifiedDensity * effectiveOpacity,
          antiAliasing: false,
          docOriginX: tile.tileX * TILE_SIZE,
          docOriginY: tile.tileY * TILE_SIZE,
        });
      }

      if (scaleRatio === 1) {
        ctx.drawImage(state.fallbackTileCanvas, tile.tileX * TILE_SIZE, tile.tileY * TILE_SIZE);
      } else {
        ctx.drawImage(
          state.fallbackTileCanvas,
          tile.tileX * lodTileDocSize,
          tile.tileY * lodTileDocSize,
          lodTileDocSize,
          lodTileDocSize
        );
      }
    }

    if (toneEnabled) {
      ctx.globalAlpha = prevAlpha;
    }
  };

  const styles = layer.styles;
  const hasStyles = hasActiveLayerStyles(styles);

  // 2D Layer Styles: Draw Drop Shadow
  if (hasStyles && styles?.dropShadow?.enabled && styles.dropShadow.opacity > 0) {
    targetCtx.save();
    const rad = ((styles.dropShadow.angle || 0) * Math.PI) / 180;
    const dist = styles.dropShadow.distance || 0;
    targetCtx.shadowColor = styles.dropShadow.color || '#000000';
    targetCtx.shadowBlur = styles.dropShadow.blur || 0;
    targetCtx.shadowOffsetX = Math.cos(rad) * dist;
    targetCtx.shadowOffsetY = Math.sin(rad) * dist;
    targetCtx.globalAlpha = layer.opacity * opacityMultiplier * styles.dropShadow.opacity;
    drawTiles(targetCtx);
    targetCtx.restore();
  }

  // 2D Layer Styles: Draw Outer Glow
  if (hasStyles && styles?.outerGlow?.enabled && styles.outerGlow.opacity > 0) {
    targetCtx.save();
    targetCtx.shadowColor = styles.outerGlow.color || '#ffff00';
    targetCtx.shadowBlur = styles.outerGlow.blur || 0;
    targetCtx.shadowOffsetX = 0;
    targetCtx.shadowOffsetY = 0;
    targetCtx.globalAlpha = layer.opacity * opacityMultiplier * styles.outerGlow.opacity;
    drawTiles(targetCtx);
    targetCtx.restore();
  }

  // WYSIWYG 2D fallback in-stack live draft compositing
  const opts = state.currentOptions;
  const has2DDraft = Boolean(
    opts?.activeDraftLayerId === layer.id &&
    opts.activeDraftCanvas &&
    (opts.activeDraftCanvas as any).__draftHasContent !== false
  );
  const draftOp2D = has2DDraft && opts?.activeDraftCanvas
    ? ((opts.activeDraftCanvas as any).__draftCompositeOp as GlobalCompositeOperation | undefined)
    : undefined;

  if (
    has2DDraft &&
    opts?.activeDraftCanvas &&
    (draftOp2D === 'destination-out' || draftOp2D === 'source-atop') &&
    typeof document !== 'undefined' &&
    targetCtx.canvas
  ) {
    if (!state.fallbackIsoCanvas) {
      state.fallbackIsoCanvas = document.createElement('canvas');
    }
    const iso = state.fallbackIsoCanvas;
    if (iso.width !== targetCtx.canvas.width || iso.height !== targetCtx.canvas.height) {
      iso.width = targetCtx.canvas.width;
      iso.height = targetCtx.canvas.height;
    }
    const isoCtx = iso.getContext('2d');
    if (isoCtx) {
      if (typeof isoCtx.setTransform === 'function') {
        isoCtx.setTransform(1, 0, 0, 1, 0, 0);
      }
      isoCtx.clearRect(0, 0, iso.width, iso.height);
      if (typeof targetCtx.getTransform === 'function' && typeof isoCtx.setTransform === 'function') {
        isoCtx.setTransform(targetCtx.getTransform());
      }
      drawTiles(isoCtx);
      isoCtx.save();
      isoCtx.globalAlpha = opts.activeDraftOpacity ?? 1.0;
      isoCtx.globalCompositeOperation = draftOp2D;
      if (opts.activeDraftSpace === 'viewport' && typeof isoCtx.setTransform === 'function') {
        isoCtx.setTransform(1, 0, 0, 1, 0, 0);
        isoCtx.drawImage(opts.activeDraftCanvas, 0, 0);
      } else if (opts.activeDraftDirtyRect) {
        const dr = opts.activeDraftDirtyRect;
        isoCtx.drawImage(opts.activeDraftCanvas, dr.x, dr.y, dr.width, dr.height);
      } else {
        isoCtx.drawImage(
          opts.activeDraftCanvas,
          0,
          0,
          opts.dimensions?.width ?? opts.activeDraftCanvas.width,
          opts.dimensions?.height ?? opts.activeDraftCanvas.height
        );
      }
      isoCtx.restore();

      targetCtx.save();
      if (typeof targetCtx.setTransform === 'function') {
        targetCtx.setTransform(1, 0, 0, 1, 0, 0);
      }
      targetCtx.drawImage(iso, 0, 0);
      targetCtx.restore();
      targetCtx.restore();
      return;
    }
  }

  // Draw main layer content
  drawTiles(targetCtx);

  if (has2DDraft && opts?.activeDraftCanvas) {
    targetCtx.save();
    targetCtx.globalAlpha *= opts.activeDraftOpacity ?? 1.0;
    if (opts.activeDraftSpace === 'viewport' && typeof targetCtx.setTransform === 'function') {
      targetCtx.setTransform(1, 0, 0, 1, 0, 0);
      targetCtx.drawImage(opts.activeDraftCanvas, 0, 0);
    } else if (opts.activeDraftDirtyRect) {
      const dr = opts.activeDraftDirtyRect;
      targetCtx.drawImage(opts.activeDraftCanvas, dr.x, dr.y, dr.width, dr.height);
    } else {
      targetCtx.drawImage(
        opts.activeDraftCanvas,
        0,
        0,
        opts.dimensions?.width ?? opts.activeDraftCanvas.width,
        opts.dimensions?.height ?? opts.activeDraftCanvas.height
      );
    }
    targetCtx.restore();
  }

  targetCtx.restore();
}

/**
 * Recursive tree rendering for 2D fallback context supporting pass-through and isolated folders.
 */
export function render2DNodeList(
  state: CompositorState,
  targetCtx: CanvasRenderingContext2D,
  nodes: LayerTreeNode[],
  dimensions: CanvasDimensions,
  grid: SparseTileGrid,
  tileCtx: CanvasRenderingContext2D | null | undefined,
  opacityMultiplier: number = 1.0,
  frustum?: DocumentBounds | null
): void {
  const renderOrder = nodes.slice().reverse();
  const groups = groupTreeNodesForCompositing(renderOrder);

  for (const group of groups) {
    const baseNode = group.baseNode;
    const baseLayer = baseNode.layer;
    if (!baseLayer.visible || baseLayer.opacity <= 0.001) continue;

    if (baseLayer.type === 'frame-folder') {
      const folderEffectiveOpacity = opacityMultiplier * baseLayer.opacity;
      const frames = (baseLayer.comicFrames || []).filter((f) => f.polygon.length >= 3);
      const shouldClip = frames.length > 0 && frames.some((f) => f.clipChildren !== false);
      let folderCanvas: HTMLCanvasElement | null = null;
      if (typeof document !== 'undefined') {
        folderCanvas = document.createElement('canvas');
        folderCanvas.width = dimensions.width;
        folderCanvas.height = dimensions.height;
      }
      const fCtx = folderCanvas?.getContext('2d');
      if (fCtx && folderCanvas) {
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
          render2DNodeList(state, fCtx, baseNode.children, dimensions, grid, tileCtx, 1.0);
        }
        fCtx.restore();

        // Render frame borders on top of clipped folder contents
        for (const frame of frames) {
          renderFrameBorder(fCtx, frame, false);
        }

        targetCtx.save();
        targetCtx.globalAlpha = Math.max(0, Math.min(1, folderEffectiveOpacity));
        const blend = baseLayer.blendMode === 'pass-through' ? 'normal' : baseLayer.blendMode;
        targetCtx.globalCompositeOperation = getCanvasCompositeOperation(blend);
        targetCtx.drawImage(folderCanvas, 0, 0);
        targetCtx.restore();
      }
      continue;
    }

    if (baseLayer.type === 'folder') {
      const isPassThrough = baseLayer.blendMode === 'pass-through';
      const folderEffectiveOpacity = opacityMultiplier * baseLayer.opacity;

      if (isPassThrough) {
        if (baseNode.children.length > 0) {
          render2DNodeList(
            state,
            targetCtx,
            baseNode.children,
            dimensions,
            grid,
            tileCtx,
            folderEffectiveOpacity
          );
        }
      } else {
        let folderCanvas: HTMLCanvasElement | null = null;
        if (typeof document !== 'undefined') {
          folderCanvas = document.createElement('canvas');
          folderCanvas.width = dimensions.width;
          folderCanvas.height = dimensions.height;
        }
        const fCtx = folderCanvas?.getContext('2d');
        if (fCtx && folderCanvas) {
          if (baseNode.children.length > 0) {
            render2DNodeList(
              state,
              fCtx,
              baseNode.children,
              dimensions,
              grid,
              tileCtx,
              1.0
            );
          }
          targetCtx.save();
          targetCtx.globalAlpha = Math.max(0, Math.min(1, folderEffectiveOpacity));
          targetCtx.globalCompositeOperation = getCanvasCompositeOperation(baseLayer.blendMode);
          targetCtx.drawImage(folderCanvas, 0, 0);
          targetCtx.restore();
        }
      }
      continue;
    }

    if (baseLayer.type === 'adjustment' && baseLayer.adjustmentData) {
      const imgData = targetCtx.getImageData(0, 0, dimensions.width, dimensions.height);
      applyAdjustment(imgData, baseLayer.adjustmentData, baseLayer.maskCanvas, baseLayer.opacity * opacityMultiplier);
      targetCtx.putImageData(imgData, 0, 0);
      continue;
    }

    const activeClipped = group.clippedNodes.filter(
      (cn) => cn.layer.visible && cn.layer.opacity > 0.001 && !isFolderLikeLayer(cn.layer)
    );

    if (activeClipped.length === 0) {
      render2DSingleLayer(state, targetCtx, baseLayer, grid, tileCtx, opacityMultiplier, frustum);
    } else {
      let groupCanvas: HTMLCanvasElement | null = null;
      if (typeof document !== 'undefined') {
        groupCanvas = document.createElement('canvas');
        groupCanvas.width = dimensions.width;
        groupCanvas.height = dimensions.height;
      }
      const gCtx = groupCanvas?.getContext('2d');
      if (!gCtx || !groupCanvas) {
        render2DSingleLayer(state, targetCtx, baseLayer, grid, tileCtx, opacityMultiplier, frustum);
        continue;
      }

      render2DSingleLayer(state, gCtx, baseLayer, grid, tileCtx, 1.0, null);

      for (const clippedNode of activeClipped) {
        const clipped = clippedNode.layer;
        gCtx.save();
        gCtx.globalAlpha = clipped.opacity;
        gCtx.globalCompositeOperation = 'source-atop';

        const tiles = grid.getLayerTiles(clipped.id);
        if (tileCtx && state.fallbackTileCanvas) {
          const imgData = getReusableTileImageData(state, tileCtx);
          for (const tile of tiles) {
            const rgba = grid.getTileAsRGBA(tile);
            imgData.data.set(rgba);
            tileCtx.putImageData(imgData, 0, 0);
            gCtx.drawImage(state.fallbackTileCanvas, tile.tileX * TILE_SIZE, tile.tileY * TILE_SIZE);
          }
        }
        gCtx.restore();
      }

      targetCtx.save();
      targetCtx.globalAlpha = Math.max(0, Math.min(1, opacityMultiplier));
      targetCtx.globalCompositeOperation = getCanvasCompositeOperation(baseLayer.blendMode);
      targetCtx.drawImage(groupCanvas, 0, 0);
      targetCtx.restore();
    }
  }
}

/**
 * 2D Canvas Fallback Pass: Blits visible tiles using frustum culling and adaptive LOD
 * when WebGL2 is unavailable or Canvas 2D software mode is selected.
 */
export function render2DFallback(
  state: CompositorState,
  layers: LayerItem[],
  transform: ViewportTransform,
  dimensions: CanvasDimensions,
  grid: SparseTileGrid,
  _options: CompositorOptions
): void {
  const ctx = state.canvas.getContext('2d');
  if (!ctx) return;

  const viewportW = state.canvas.width;
  const viewportH = state.canvas.height;
  const dpr = _options.devicePixelRatio ?? (typeof window !== 'undefined' ? window.devicePixelRatio : 1) ?? 1;

  // Frustum Culling & Memory Manager Sync (keeps RAM eviction accurate even in CPU 2D mode)
  const frustum = calculateVisibleDocumentBounds(
    viewportW / Math.max(0.01, dpr),
    viewportH / Math.max(0.01, dpr),
    transform,
    dimensions.width,
    dimensions.height
  );
  const activeLayerId = _options.activeLayerId ?? _options.activeDraftLayerId ?? null;
  const layerVis = state.layerVisScratch;
  layerVis.clear();
  for (let i = 0; i < layers.length; i++) {
    layerVis.set(layers[i].id, layers[i].visible);
  }
  grid.getMemoryManager()?.updateViewport(frustum, activeLayerId, layerVis);

  ctx.save();
  ctx.clearRect(0, 0, viewportW, viewportH);

  // Respect texture filtering quality preference in 2D mode
  const shouldSmooth =
    state.filteringQuality === 'smooth'
      ? true
      : state.filteringQuality === 'pixelated'
        ? false
        : transform.zoom < 2.0;
  ctx.imageSmoothingEnabled = shouldSmooth;

  ctx.scale(dpr, dpr);
  ctx.translate(transform.pan.x, transform.pan.y);
  ctx.rotate((transform.rotation * Math.PI) / 180);
  ctx.scale(
    (transform.flipX ? -1 : 1) * transform.zoom,
    (transform.flipY ? -1 : 1) * transform.zoom
  );
  ctx.translate(-dimensions.width / 2, -dimensions.height / 2);

  if (!_options.transparentBackground) {
    if (_options.showCheckerboard) {
      ctx.fillStyle = '#1e1e1e';
    } else {
      ctx.fillStyle = '#ffffff';
    }
    ctx.fillRect(0, 0, dimensions.width, dimensions.height);
  }

  if (!state.fallbackTileCanvas && typeof document !== 'undefined') {
    state.fallbackTileCanvas = document.createElement('canvas');
    state.fallbackTileCanvas.width = TILE_SIZE;
    state.fallbackTileCanvas.height = TILE_SIZE;
  }
  const tileCtx = state.fallbackTileCanvas?.getContext('2d', { willReadFrequently: true });

  const tree = buildLayerTree(layers);
  render2DNodeList(state, ctx, tree, dimensions, grid, tileCtx, 1.0, frustum);

  ctx.restore();
}
