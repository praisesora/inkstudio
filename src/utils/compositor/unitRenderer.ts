import { BlendMode, CanvasDimensions, isFolderLikeLayer } from '../../types/editor';
import { buildFrameBorderTriangles, triangulatePolygon } from '../frameEngine';
import { SparseTileGrid } from '../tileEngine';
import { parseHexColor } from './bounds';
import {
  blitFolderTexture,
  drawFramePolygonTriangles,
  renderAdjustmentLayer,
} from './effectsPass';
import { ensureFolderPingPong } from './fboManager';
import { renderLayerWithStyles, renderSingleLayer } from './layerRenderer';
import { flattenLayerTreeToUnits } from './layerTree';
import { hasActiveLayerStyles } from './shaders/effectShaders';
import {
  CompositingUnit,
  CompositorState,
  DocumentBounds,
  LayerTreeNode,
  PingPongTarget,
  ViewportTransform,
} from './types';

/**
 * Renders a single atomic CompositingUnit (an isolated folder, adjustment layer, or base + clipped group)
 * into the active Ping-Pong target.
 */
export function renderCompositingUnit(
  state: CompositorState,
  gl: WebGL2RenderingContext,
  unit: CompositingUnit,
  dimensions: CanvasDimensions,
  grid: SparseTileGrid,
  frustum: DocumentBounds,
  viewportW: number,
  viewportH: number,
  transform: ViewportTransform,
  dpr: number,
  target: PingPongTarget | null,
  depth: number,
  overrideRootBlendNormal: boolean
): void {
  const group = unit.group;
  const baseNode = group.baseNode;
  const baseLayer = overrideRootBlendNormal
    ? { ...baseNode.layer, blendMode: 'normal' as BlendMode }
    : baseNode.layer;

  if (!baseLayer.visible || baseLayer.opacity <= 0.001) {
    return;
  }

  if (baseLayer.type === 'frame-folder') {
    const folderTarget = ensureFolderPingPong(state, gl, depth, viewportW, viewportH);
    if (!folderTarget) return;

    const frames = (baseLayer.comicFrames || []).filter((f) => f.polygon.length >= 3);

    // 1. Render nested child layers into folderTarget.surfaces[0] cleanly (no stencil conflict with child clipping masks)
    folderTarget.activeIndex = 0;
    const childSurf = folderTarget.surfaces[0];
    gl.bindFramebuffer(gl.FRAMEBUFFER, childSurf.fbo);
    gl.viewport(0, 0, viewportW, viewportH);
    gl.disable(gl.STENCIL_TEST);
    gl.clearColor(0.0, 0.0, 0.0, 0.0);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.STENCIL_BUFFER_BIT);

    if (baseNode.children.length > 0) {
      renderNodeList(
        state,
        gl,
        baseNode.children,
        dimensions,
        grid,
        frustum,
        viewportW,
        viewportH,
        transform,
        dpr,
        folderTarget,
        depth + 1,
        1.0
      );
    }

    const renderedChildrenTex = folderTarget.surfaces[folderTarget.activeIndex].texture;
    const outIdx: 0 | 1 = folderTarget.activeIndex === 0 ? 1 : 0;
    const outSurf = folderTarget.surfaces[outIdx];

    gl.bindFramebuffer(gl.FRAMEBUFFER, outSurf.fbo);
    gl.viewport(0, 0, viewportW, viewportH);
    gl.disable(gl.STENCIL_TEST);
    gl.clearColor(0.0, 0.0, 0.0, 0.0);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.STENCIL_BUFFER_BIT);

    const shouldClip = frames.length > 0 && frames.some((f) => f.clipChildren !== false);

    if (frames.length > 0 && state.framePolyProgram && state.framePolyBuffer) {
      // 2. Write frame polygon interiors into stencil buffer (and optional background fill)
      if (shouldClip) {
        gl.enable(gl.STENCIL_TEST);
        gl.stencilMask(0xFF);
        gl.stencilFunc(gl.ALWAYS, 1, 0xFF);
        gl.stencilOp(gl.KEEP, gl.KEEP, gl.REPLACE);
      }

      for (const frame of frames) {
        const fillVerts = triangulatePolygon(frame.polygon);
        if (fillVerts.length < 6) continue;
        const doFill = frame.fillBackground !== false;
        if (!doFill) {
          gl.colorMask(false, false, false, false);
        }
        const [fr, fg, fb] = parseHexColor(frame.fillColor || '#ffffff');
        drawFramePolygonTriangles(
          state,
          gl,
          fillVerts,
          fr,
          fg,
          fb,
          1.0,
          dimensions,
          viewportW,
          viewportH,
          transform,
          dpr
        );
        if (!doFill) {
          gl.colorMask(true, true, true, true);
        }
      }

      // 3. Blit rendered children strictly inside stencil == 1
      if (shouldClip) {
        gl.stencilMask(0x00);
        gl.stencilFunc(gl.EQUAL, 1, 0xFF);
        gl.stencilOp(gl.KEEP, gl.KEEP, gl.KEEP);
      }

      blitFolderTexture(
        state,
        gl,
        renderedChildrenTex,
        'normal',
        1.0,
        viewportW,
        viewportH,
        null,
        shouldClip
      );

      gl.stencilMask(0xFF);
      gl.disable(gl.STENCIL_TEST);

      // 4. Draw crisp frame borders ON TOP of clipped folder contents
      for (const frame of frames) {
        const borderVerts = buildFrameBorderTriangles(frame.polygon, frame.borderWidth || 3);
        if (borderVerts.length < 6) continue;
        const [sr, sg, sb] = parseHexColor(frame.strokeColor || '#000000');
        drawFramePolygonTriangles(
          state,
          gl,
          borderVerts,
          sr,
          sg,
          sb,
          1.0,
          dimensions,
          viewportW,
          viewportH,
          transform,
          dpr
        );
      }

      folderTarget.activeIndex = outIdx;
    }

    // 5. Composite finished frame folder onto parent framebuffer
    const parentFbo = target ? target.surfaces[target.activeIndex].fbo : null;
    gl.bindFramebuffer(gl.FRAMEBUFFER, parentFbo);
    gl.viewport(0, 0, viewportW, viewportH);

    const folderBlend = baseLayer.blendMode === 'pass-through' ? 'normal' : baseLayer.blendMode;
    blitFolderTexture(
      state,
      gl,
      folderTarget.surfaces[folderTarget.activeIndex].texture,
      folderBlend,
      baseLayer.opacity * unit.inheritedOpacity,
      viewportW,
      viewportH,
      target,
      false
    );
    return;
  }

  if (baseLayer.type === 'folder') {
    const folderTarget = ensureFolderPingPong(state, gl, depth, viewportW, viewportH);
    if (!folderTarget) return;

    folderTarget.activeIndex = 0;
    const folderSurf = folderTarget.surfaces[0];
    gl.bindFramebuffer(gl.FRAMEBUFFER, folderSurf.fbo);
    gl.viewport(0, 0, viewportW, viewportH);
    gl.disable(gl.STENCIL_TEST);
    gl.clearColor(0.0, 0.0, 0.0, 0.0);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.STENCIL_BUFFER_BIT);

    renderNodeList(
      state,
      gl,
      baseNode.children,
      dimensions,
      grid,
      frustum,
      viewportW,
      viewportH,
      transform,
      dpr,
      folderTarget,
      depth + 1,
      1.0
    );

    // Restore parent target framebuffer and blit isolated folder result
    const parentFbo = target ? target.surfaces[target.activeIndex].fbo : null;
    gl.bindFramebuffer(gl.FRAMEBUFFER, parentFbo);
    gl.viewport(0, 0, viewportW, viewportH);

    blitFolderTexture(
      state,
      gl,
      folderTarget.surfaces[folderTarget.activeIndex].texture,
      baseLayer.blendMode,
      baseLayer.opacity * unit.inheritedOpacity,
      viewportW,
      viewportH,
      target,
      false
    );
    return;
  }

  const activeClippedLayers = group.clippedNodes
    .map((n) => n.layer)
    .filter((cl) => cl.visible && cl.opacity > 0.001 && !isFolderLikeLayer(cl));

  const baseEffectiveOpacity = unit.inheritedOpacity;

  if (baseLayer.type === 'adjustment' && baseLayer.adjustmentData) {
    renderAdjustmentLayer(
      state,
      gl,
      baseLayer,
      transform,
      dimensions,
      viewportW,
      viewportH,
      dpr,
      baseEffectiveOpacity,
      target,
      false
    );
    return;
  }

  const baseHasStyles = hasActiveLayerStyles(baseLayer.styles);

  if (activeClippedLayers.length > 0) {
    // Record base layer silhouette in stencil buffer of the current Ping-Pong surface
    gl.enable(gl.STENCIL_TEST);
    gl.clear(gl.STENCIL_BUFFER_BIT);
    gl.stencilMask(0xFF);
    gl.stencilFunc(gl.ALWAYS, 1, 0xFF);
    gl.stencilOp(gl.KEEP, gl.KEEP, gl.REPLACE);

    if (baseHasStyles) {
      // Record base layer silhouette in stencil without writing colors
      gl.colorMask(false, false, false, false);
      renderSingleLayer(
        state,
        gl,
        { ...baseLayer, blendMode: 'normal' },
        dimensions,
        grid,
        frustum,
        baseEffectiveOpacity,
        target,
        true
      );
      gl.colorMask(true, true, true, true);

      // Draw base layer with styles (do not overwrite stencil with shadow/glow)
      gl.stencilMask(0x00);
      renderLayerWithStyles(
        state,
        gl,
        baseLayer,
        dimensions,
        grid,
        frustum,
        viewportW,
        viewportH,
        transform,
        dpr,
        baseEffectiveOpacity,
        target,
        true
      );
      gl.stencilMask(0xFF);
    } else {
      renderSingleLayer(
        state,
        gl,
        baseLayer,
        dimensions,
        grid,
        frustum,
        baseEffectiveOpacity,
        target,
        true
      );
    }

    // Render clipped layers: only draw over opaque pixels of base layer (stencil == 1)
    gl.stencilMask(0x00);
    gl.stencilFunc(gl.EQUAL, 1, 0xFF);
    gl.stencilOp(gl.KEEP, gl.KEEP, gl.KEEP);

    for (const clippedLayer of activeClippedLayers) {
      if (hasActiveLayerStyles(clippedLayer.styles)) {
        renderLayerWithStyles(
          state,
          gl,
          clippedLayer,
          dimensions,
          grid,
          frustum,
          viewportW,
          viewportH,
          transform,
          dpr,
          baseEffectiveOpacity,
          target,
          true
        );
      } else {
        renderSingleLayer(
          state,
          gl,
          clippedLayer,
          dimensions,
          grid,
          frustum,
          baseEffectiveOpacity,
          target,
          true
        );
      }
    }

    gl.stencilMask(0xFF);
    gl.disable(gl.STENCIL_TEST);
  } else {
    gl.disable(gl.STENCIL_TEST);
    if (baseHasStyles) {
      renderLayerWithStyles(
        state,
        gl,
        baseLayer,
        dimensions,
        grid,
        frustum,
        viewportW,
        viewportH,
        transform,
        dpr,
        baseEffectiveOpacity,
        target,
        false
      );
    } else {
      renderSingleLayer(
        state,
        gl,
        baseLayer,
        dimensions,
        grid,
        frustum,
        baseEffectiveOpacity,
        target,
        false
      );
    }
  }
}

/**
 * Recursively composite a layer hierarchy, supporting folder pass-through and isolated offscreen rendering.
 */
export function renderNodeList(
  state: CompositorState,
  gl: WebGL2RenderingContext,
  nodes: LayerTreeNode[],
  dimensions: CanvasDimensions,
  grid: SparseTileGrid,
  frustum: DocumentBounds,
  viewportW: number,
  viewportH: number,
  transform: ViewportTransform,
  dpr: number,
  target: PingPongTarget | null,
  depth: number,
  inheritedOpacity: number
): void {
  const units = flattenLayerTreeToUnits(nodes, inheritedOpacity);
  for (const unit of units) {
    renderCompositingUnit(
      state,
      gl,
      unit,
      dimensions,
      grid,
      frustum,
      viewportW,
      viewportH,
      transform,
      dpr,
      target,
      depth,
      false
    );
  }
}
