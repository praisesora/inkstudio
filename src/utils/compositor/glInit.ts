import { TILE_SIZE } from '../tileEngine';
import { invalidatePigmentLutTexture } from '../pigmentEngine';
import {
  COMPOSITOR_FRAGMENT_SHADER,
  COMPOSITOR_VERTEX_SHADER,
  FOLDER_BLIT_FRAGMENT_SHADER,
  FOLDER_BLIT_VERTEX_SHADER,
  FRAME_POLY_FRAGMENT_SHADER,
  FRAME_POLY_VERTEX_SHADER,
  PIGMENT_DRAFT_FRAGMENT_SHADER,
  VIEWPORT_DRAFT_VERTEX_SHADER,
} from './shaders/coreShaders';
import {
  COMPOSITOR_INSTANCED_FRAGMENT_SHADER,
  COMPOSITOR_INSTANCED_VERTEX_SHADER,
} from './shaders/instancedShaders';
import {
  ADJUSTMENT_FRAGMENT_SHADER,
  LAYER_STYLES_FRAGMENT_SHADER,
  LAYER_STYLES_VERTEX_SHADER,
} from './shaders/effectShaders';
import {
  SOFT_PROOF_FRAGMENT_SHADER,
  SOFT_PROOF_VERTEX_SHADER,
} from './shaders/softProofShaders';
import {
  ArrayPoolSlot,
  CompositorState,
  DEFAULT_ARRAY_POOL_LAYERS,
  LayerUniformLocs,
} from './types';

function compileShader(
  gl: WebGL2RenderingContext,
  type: number,
  source: string
): WebGLShader | null {
  const shader = gl.createShader(type);
  if (!shader) return null;
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  return shader;
}

function linkProgram(
  gl: WebGL2RenderingContext,
  vs: WebGLShader,
  fs: WebGLShader
): WebGLProgram | null {
  const prog = gl.createProgram();
  if (!prog) return null;
  gl.attachShader(prog, vs);
  gl.attachShader(prog, fs);
  gl.linkProgram(prog);
  return prog;
}

export function queryLayerUniformLocs(
  gl: WebGL2RenderingContext,
  prog: WebGLProgram
): LayerUniformLocs {
  return {
    uDocDimensions: gl.getUniformLocation(prog, 'u_docDimensions'),
    uViewportSize: gl.getUniformLocation(prog, 'u_viewportSize'),
    uPan: gl.getUniformLocation(prog, 'u_pan'),
    uZoom: gl.getUniformLocation(prog, 'u_zoom'),
    uRotationRad: gl.getUniformLocation(prog, 'u_rotationRad'),
    uFlip: gl.getUniformLocation(prog, 'u_flip'),
    uDpr: gl.getUniformLocation(prog, 'u_dpr'),
    uBackdropTexture: gl.getUniformLocation(prog, 'u_backdropTexture'),
    uHasBackdrop: gl.getUniformLocation(prog, 'u_hasBackdrop'),
    uLayerOpacity: gl.getUniformLocation(prog, 'u_layerOpacity'),
    uBlendMode: gl.getUniformLocation(prog, 'u_blendMode'),
    uToneEnabled: gl.getUniformLocation(prog, 'u_toneEnabled'),
    uToneFrequency: gl.getUniformLocation(prog, 'u_toneFrequency'),
    uToneAngleRad: gl.getUniformLocation(prog, 'u_toneAngleRad'),
    uToneDpi: gl.getUniformLocation(prog, 'u_toneDpi'),
    uToneDotShape: gl.getUniformLocation(prog, 'u_toneDotShape'),
    uToneDensity: gl.getUniformLocation(prog, 'u_toneDensity'),
    uToneDensityType: gl.getUniformLocation(prog, 'u_toneDensityType'),
    uLayerColorEnabled: gl.getUniformLocation(prog, 'u_layerColorEnabled'),
    uLayerColor: gl.getUniformLocation(prog, 'u_layerColor'),
    uLayerSubColor: gl.getUniformLocation(prog, 'u_layerSubColor'),
    uMaskTexture: gl.getUniformLocation(prog, 'u_maskTexture'),
    uMaskEnabled: gl.getUniformLocation(prog, 'u_maskEnabled'),
    uExpressionMode: gl.getUniformLocation(prog, 'u_expressionMode'),
    uMonoThreshold: gl.getUniformLocation(prog, 'u_monoThreshold'),
    uMonoExpressBlack: gl.getUniformLocation(prog, 'u_monoExpressBlack'),
    uMonoExpressWhite: gl.getUniformLocation(prog, 'u_monoExpressWhite'),
  };
}

export function initTileArrayPool(state: CompositorState, gl: WebGL2RenderingContext): void {
  if (
    typeof gl.texStorage3D !== 'function' ||
    typeof gl.texSubImage3D !== 'function' ||
    typeof gl.drawArraysInstanced !== 'function' ||
    typeof gl.vertexAttribDivisor !== 'function' ||
    !state.quadBuffer
  ) {
    return;
  }

  const instVs = compileShader(gl, gl.VERTEX_SHADER, COMPOSITOR_INSTANCED_VERTEX_SHADER);
  const instFs = compileShader(gl, gl.FRAGMENT_SHADER, COMPOSITOR_INSTANCED_FRAGMENT_SHADER);
  if (!instVs || !instFs) return;

  if (
    !gl.getShaderParameter(instVs, gl.COMPILE_STATUS) ||
    !gl.getShaderParameter(instFs, gl.COMPILE_STATUS)
  ) {
    console.error(
      'Instanced tile shader compile error:',
      gl.getShaderInfoLog(instVs),
      gl.getShaderInfoLog(instFs)
    );
    return;
  }

  const iProg = linkProgram(gl, instVs, instFs);
  if (!iProg) return;
  if (!gl.getProgramParameter(iProg, gl.LINK_STATUS)) {
    console.error('Instanced tile program link error:', gl.getProgramInfoLog(iProg));
    return;
  }

  const desiredLayers = state.requestedArrayPoolLayers || DEFAULT_ARRAY_POOL_LAYERS;
  const maxLayersParam =
    Number(gl.getParameter(gl.MAX_ARRAY_TEXTURE_LAYERS)) || desiredLayers;
  const capacity = Math.max(1, Math.min(desiredLayers, maxLayersParam));

  const arrTex = gl.createTexture();
  const instBuf = gl.createBuffer();
  if (!arrTex || !instBuf) {
    if (arrTex) gl.deleteTexture(arrTex);
    if (instBuf) gl.deleteBuffer(instBuf);
    gl.deleteProgram(iProg);
    return;
  }

  gl.bindTexture(gl.TEXTURE_2D_ARRAY, arrTex);
  gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texStorage3D(gl.TEXTURE_2D_ARRAY, 1, gl.RGBA8, TILE_SIZE, TILE_SIZE, capacity);
  gl.bindTexture(gl.TEXTURE_2D_ARRAY, null);

  state.instanceFloatScratch = new Float32Array(capacity * 3);
  gl.bindBuffer(gl.ARRAY_BUFFER, instBuf);
  gl.bufferData(gl.ARRAY_BUFFER, state.instanceFloatScratch.byteLength, gl.DYNAMIC_DRAW);

  state.instancedProgram = iProg;
  state.instancedLocs = queryLayerUniformLocs(gl, iProg);
  state.uInstTileSizeLoc = gl.getUniformLocation(iProg, 'u_tileSize');
  state.uInstTileArrayLoc = gl.getUniformLocation(iProg, 'u_tileArrayTexture');
  state.aInstQuadPosLoc = gl.getAttribLocation(iProg, 'a_quadPos');
  state.aInstDataLoc = gl.getAttribLocation(iProg, 'a_instanceData');

  // Immediately bind distinct texture units for sampler2DArray (0) vs sampler2D (1, 2)
  // to prevent WebGL2 GL_INVALID_OPERATION sampler-type collisions on unit 0.
  gl.useProgram(iProg);
  gl.uniform1i(state.uInstTileArrayLoc, 0);
  gl.uniform1i(state.instancedLocs.uMaskTexture, 1);
  gl.uniform1i(state.instancedLocs.uBackdropTexture, 2);
  if (state.program) {
    gl.useProgram(state.program);
  }

  state.tileArrayTexture = arrTex;
  state.instanceBuffer = instBuf;
  state.arrayPoolCapacity = capacity;
  state.arrayPoolFilterTier = 1;
  state.arrayPoolSlots = [];
  state.freeArraySlots = [];
  state.arrayPoolByKey.clear();
  for (let i = 0; i < capacity; i++) {
    const slot: ArrayPoolSlot = {
      sliceIndex: i,
      currentKey: null,
      version: -1,
      lastUsed: 0,
      lastBatchTick: 0,
    };
    state.arrayPoolSlots.push(slot);
  }
  for (let i = capacity - 1; i >= 0; i--) {
    state.freeArraySlots.push(state.arrayPoolSlots[i]);
  }

  if (typeof gl.createVertexArray === 'function') {
    const vao = gl.createVertexArray();
    if (vao) {
      gl.bindVertexArray(vao);
      gl.bindBuffer(gl.ARRAY_BUFFER, state.quadBuffer);
      if (state.aInstQuadPosLoc >= 0) {
        gl.enableVertexAttribArray(state.aInstQuadPosLoc);
        gl.vertexAttribPointer(state.aInstQuadPosLoc, 2, gl.FLOAT, false, 0, 0);
        gl.vertexAttribDivisor(state.aInstQuadPosLoc, 0);
      }
      gl.bindBuffer(gl.ARRAY_BUFFER, state.instanceBuffer);
      if (state.aInstDataLoc >= 0) {
        gl.enableVertexAttribArray(state.aInstDataLoc);
        gl.vertexAttribPointer(state.aInstDataLoc, 3, gl.FLOAT, false, 0, 0);
        gl.vertexAttribDivisor(state.aInstDataLoc, 1);
      }
      gl.bindVertexArray(null);
      state.instancedVao = vao;
    }
  }
}

export function resetGLStateOnContextLost(state: CompositorState): void {
  invalidatePigmentLutTexture(state.gl, false);
  state.contextLost = true;
  state.gl = null;
  state.program = null;
  state.instancedProgram = null;
  state.instancedVao = null;
  state.instanceBuffer = null;
  state.tileArrayTexture = null;
  state.arrayPoolSlots = [];
  state.freeArraySlots = [];
  state.arrayPoolByKey.clear();
  state.arrayPoolCapacity = 0;
  state.arrayPoolFilterTier = -1;
  state.viewportDraftProgram = null;
  state.pigmentDraftProgram = null;
  state.adjProgram = null;
  state.stylesProgram = null;
  state.blitProgram = null;
  state.framePolyProgram = null;
  state.framePolyBuffer = null;
  state.softProofProgram = null;
  state.texturePool = [];
  state.activePoolByKey.clear();
  state.maskTextureCache.clear();
  state.scenePingPong = null;
  state.folderPingPongs = [];
  state.belowActiveCacheFbo = null;
  state.aboveActiveCacheFbo = null;
  state.layerStylesOutFbo = null;
  state.layerFbo = null;
  state.layerTexture = null;
  state.lutTexture = null;
  state.draftTexture = null;
  state.draftTexWidth = 0;
  state.draftTexHeight = 0;
  state.draftHasMipmap = false;
  state.draftNeedsFullUpload = true;
  state.lastDraftLayerId = null;
  state.lastDraftVersion = -1;
  state.stackCache.invalidateAll();
}

export function initGL(state: CompositorState): boolean {
  if (state.renderBackend === 'canvas2d') {
    state.activeRendererName = 'Canvas 2D (CPU Software)';
    return false;
  }
  if (state.gl && state.program) return true;

  try {
    const gl = state.canvas.getContext('webgl2', {
      alpha: true,
      premultipliedAlpha: true,
      antialias: false,
      depth: false,
      stencil: true,
      preserveDrawingBuffer: state.preserveDrawingBuffer,
      powerPreference: state.powerPreference || 'high-performance',
    });

    if (!gl) {
      state.activeRendererName = 'Canvas 2D Fallback';
      return false;
    }
    state.gl = gl;

    // Detect active GPU renderer string once on context creation
    let rendererName = 'WebGL2 GPU';
    if (typeof gl.getExtension === 'function') {
      const debugExt = gl.getExtension('WEBGL_debug_renderer_info');
      if (debugExt) {
        const rawRenderer = gl.getParameter(debugExt.UNMASKED_RENDERER_WEBGL);
        if (typeof rawRenderer === 'string' && rawRenderer.trim()) {
          rendererName = rawRenderer.trim();
        }
      }
    }
    state.activeRendererName = rendererName;

    // Compile vertex shader
    const vs = compileShader(gl, gl.VERTEX_SHADER, COMPOSITOR_VERTEX_SHADER);
    if (!vs) return false;
    if (!gl.getShaderParameter(vs, gl.COMPILE_STATUS)) {
      console.error('Compositor VS error:', gl.getShaderInfoLog(vs));
      return false;
    }

    // Compile fragment shader
    const fs = compileShader(gl, gl.FRAGMENT_SHADER, COMPOSITOR_FRAGMENT_SHADER);
    if (!fs) return false;
    if (!gl.getShaderParameter(fs, gl.COMPILE_STATUS)) {
      console.error('Compositor FS error:', gl.getShaderInfoLog(fs));
      return false;
    }

    // Link standard compositor program
    const prog = linkProgram(gl, vs, fs);
    if (!prog) return false;
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
      console.error('Compositor link error:', gl.getProgramInfoLog(prog));
      return false;
    }
    state.program = prog;
    state.stdLocs = queryLayerUniformLocs(gl, prog);

    // Cache standard-only uniforms
    state.uTileOriginLoc = gl.getUniformLocation(prog, 'u_tileOrigin');
    state.uTileSizeLoc = gl.getUniformLocation(prog, 'u_tileSize');
    state.uIsBackgroundLoc = gl.getUniformLocation(prog, 'u_isBackground');
    state.uShowCheckerboardLoc = gl.getUniformLocation(prog, 'u_showCheckerboard');
    state.uTileTextureLoc = gl.getUniformLocation(prog, 'u_tileTexture');
    state.aQuadPosLoc = gl.getAttribLocation(prog, 'a_quadPos');

    // Compile Viewport-Space Draft Shader Program (shares COMPOSITOR_FRAGMENT_SHADER)
    const draftVs = compileShader(gl, gl.VERTEX_SHADER, VIEWPORT_DRAFT_VERTEX_SHADER);
    if (draftVs && gl.getShaderParameter(draftVs, gl.COMPILE_STATUS)) {
      const dProg = linkProgram(gl, draftVs, fs);
      if (dProg && gl.getProgramParameter(dProg, gl.LINK_STATUS)) {
        state.viewportDraftProgram = dProg;
        state.viewportDraftLocs = queryLayerUniformLocs(gl, dProg);
        state.uViewportDraftTileTexLoc = gl.getUniformLocation(dProg, 'u_tileTexture');
        state.uViewportDraftIsBgLoc = gl.getUniformLocation(dProg, 'u_isBackground');
        state.aViewportDraftQuadPosLoc = gl.getAttribLocation(dProg, 'a_quadPos');
      }
    }

    // Compile Adjustment Shader Program
    const adjFs = compileShader(gl, gl.FRAGMENT_SHADER, ADJUSTMENT_FRAGMENT_SHADER);
    if (adjFs) {
      if (gl.getShaderParameter(adjFs, gl.COMPILE_STATUS)) {
        const aProg = linkProgram(gl, vs, adjFs);
        if (aProg && gl.getProgramParameter(aProg, gl.LINK_STATUS)) {
          state.adjProgram = aProg;
          state.uAdjTileOriginLoc = gl.getUniformLocation(aProg, 'u_tileOrigin');
          state.uAdjTileSizeLoc = gl.getUniformLocation(aProg, 'u_tileSize');
          state.uAdjDocDimensionsLoc = gl.getUniformLocation(aProg, 'u_docDimensions');
          state.uAdjViewportSizeLoc = gl.getUniformLocation(aProg, 'u_viewportSize');
          state.uAdjPanLoc = gl.getUniformLocation(aProg, 'u_pan');
          state.uAdjZoomLoc = gl.getUniformLocation(aProg, 'u_zoom');
          state.uAdjRotationRadLoc = gl.getUniformLocation(aProg, 'u_rotationRad');
          state.uAdjFlipLoc = gl.getUniformLocation(aProg, 'u_flip');
          state.uAdjDprLoc = gl.getUniformLocation(aProg, 'u_dpr');
          state.uAdjSnapshotLoc = gl.getUniformLocation(aProg, 'u_snapshotTexture');
          state.uAdjLutLoc = gl.getUniformLocation(aProg, 'u_lutTexture');
          state.uAdjModeLoc = gl.getUniformLocation(aProg, 'u_adjMode');
          state.uAdjOpacityLoc = gl.getUniformLocation(aProg, 'u_layerOpacity');
          state.uAdjMaskEnabledLoc = gl.getUniformLocation(aProg, 'u_maskEnabled');
          state.uAdjMaskTextureLoc = gl.getUniformLocation(aProg, 'u_maskTexture');
        }
      } else {
        console.error('Adjustment FS error:', gl.getShaderInfoLog(adjFs));
      }
    }

    // Compile Layer Styles Shader Program
    const stylesVs = compileShader(gl, gl.VERTEX_SHADER, LAYER_STYLES_VERTEX_SHADER);
    const stylesFs = compileShader(gl, gl.FRAGMENT_SHADER, LAYER_STYLES_FRAGMENT_SHADER);
    if (stylesVs && stylesFs) {
      if (
        gl.getShaderParameter(stylesVs, gl.COMPILE_STATUS) &&
        gl.getShaderParameter(stylesFs, gl.COMPILE_STATUS)
      ) {
        const sProg = linkProgram(gl, stylesVs, stylesFs);
        if (sProg && gl.getProgramParameter(sProg, gl.LINK_STATUS)) {
          state.stylesProgram = sProg;
          state.aStylesQuadPosLoc = gl.getAttribLocation(sProg, 'a_quadPos');
          state.uStylesLayerTextureLoc = gl.getUniformLocation(sProg, 'u_layerTexture');
          state.uStylesViewportSizeLoc = gl.getUniformLocation(sProg, 'u_viewportSize');
          state.uStylesLayerOpacityLoc = gl.getUniformLocation(sProg, 'u_layerOpacity');
          state.uStylesStrokeEnabledLoc = gl.getUniformLocation(sProg, 'u_strokeEnabled');
          state.uStylesStrokeSizeLoc = gl.getUniformLocation(sProg, 'u_strokeSize');
          state.uStylesStrokeColorLoc = gl.getUniformLocation(sProg, 'u_strokeColor');
          state.uStylesStrokePositionLoc = gl.getUniformLocation(sProg, 'u_strokePosition');
          state.uStylesGlowEnabledLoc = gl.getUniformLocation(sProg, 'u_glowEnabled');
          state.uStylesGlowColorLoc = gl.getUniformLocation(sProg, 'u_glowColor');
          state.uStylesGlowBlurLoc = gl.getUniformLocation(sProg, 'u_glowBlur');
          state.uStylesGlowSpreadLoc = gl.getUniformLocation(sProg, 'u_glowSpread');
          state.uStylesShadowEnabledLoc = gl.getUniformLocation(sProg, 'u_shadowEnabled');
          state.uStylesShadowColorLoc = gl.getUniformLocation(sProg, 'u_shadowColor');
          state.uStylesShadowOffsetLoc = gl.getUniformLocation(sProg, 'u_shadowOffset');
          state.uStylesShadowBlurLoc = gl.getUniformLocation(sProg, 'u_shadowBlur');
          state.uStylesShadowSpreadLoc = gl.getUniformLocation(sProg, 'u_shadowSpread');
        }
      } else {
        console.error('Layer Styles shader compile error:', gl.getShaderInfoLog(stylesFs));
      }
    }

    // Compile Folder / Cache Blit Shader Program
    const blitVs = compileShader(gl, gl.VERTEX_SHADER, FOLDER_BLIT_VERTEX_SHADER);
    const blitFs = compileShader(gl, gl.FRAGMENT_SHADER, FOLDER_BLIT_FRAGMENT_SHADER);
    if (
      blitVs &&
      blitFs &&
      gl.getShaderParameter(blitVs, gl.COMPILE_STATUS) &&
      gl.getShaderParameter(blitFs, gl.COMPILE_STATUS)
    ) {
      const bProg = linkProgram(gl, blitVs, blitFs);
      if (bProg && gl.getProgramParameter(bProg, gl.LINK_STATUS)) {
        state.blitProgram = bProg;
        state.aBlitQuadPosLoc = gl.getAttribLocation(bProg, 'a_quadPos');
        state.uBlitTextureLoc = gl.getUniformLocation(bProg, 'u_blitTexture');
        state.uBlitBackdropTextureLoc = gl.getUniformLocation(bProg, 'u_backdropTexture');
        state.uBlitHasBackdropLoc = gl.getUniformLocation(bProg, 'u_hasBackdrop');
        state.uBlitBlendModeLoc = gl.getUniformLocation(bProg, 'u_blendMode');
        state.uBlitOpacityLoc = gl.getUniformLocation(bProg, 'u_blitOpacity');
      }
    }

    // Compile Live Pigment Draft Compositing Program (reuses FOLDER_BLIT_VERTEX_SHADER)
    const pigDraftFs = compileShader(gl, gl.FRAGMENT_SHADER, PIGMENT_DRAFT_FRAGMENT_SHADER);
    if (
      blitVs &&
      pigDraftFs &&
      gl.getShaderParameter(blitVs, gl.COMPILE_STATUS) &&
      gl.getShaderParameter(pigDraftFs, gl.COMPILE_STATUS)
    ) {
      const pdProg = linkProgram(gl, blitVs, pigDraftFs);
      if (pdProg && gl.getProgramParameter(pdProg, gl.LINK_STATUS)) {
        state.pigmentDraftProgram = pdProg;
        state.aPigmentDraftQuadPosLoc = gl.getAttribLocation(pdProg, 'a_quadPos');
        state.uPigmentDraftLayerTexLoc = gl.getUniformLocation(pdProg, 'u_layerTex');
        state.uPigmentDraftDraftTexLoc = gl.getUniformLocation(pdProg, 'u_draftTex');
        state.uPigmentDraftMaskTexLoc = gl.getUniformLocation(pdProg, 'u_maskTex');
        state.uPigmentDraftLutTexLoc = gl.getUniformLocation(pdProg, 'u_pigmentLut');
        state.uPigmentDraftDocDimensionsLoc = gl.getUniformLocation(pdProg, 'u_docDimensions');
        state.uPigmentDraftViewportSizeLoc = gl.getUniformLocation(pdProg, 'u_viewportSize');
        state.uPigmentDraftPanLoc = gl.getUniformLocation(pdProg, 'u_pan');
        state.uPigmentDraftZoomLoc = gl.getUniformLocation(pdProg, 'u_zoom');
        state.uPigmentDraftRotationRadLoc = gl.getUniformLocation(pdProg, 'u_rotationRad');
        state.uPigmentDraftFlipLoc = gl.getUniformLocation(pdProg, 'u_flip');
        state.uPigmentDraftDprLoc = gl.getUniformLocation(pdProg, 'u_dpr');
        state.uPigmentDraftRectLoc = gl.getUniformLocation(pdProg, 'u_draftRect');
        state.uPigmentDraftSpaceLoc = gl.getUniformLocation(pdProg, 'u_draftSpace');
        state.uPigmentDraftOpacityLoc = gl.getUniformLocation(pdProg, 'u_draftOpacity');
        state.uPigmentDraftStrengthLoc = gl.getUniformLocation(pdProg, 'u_pigmentStrength');
        state.uPigmentDraftWhiteGroundLoc = gl.getUniformLocation(pdProg, 'u_whiteGround');
        state.uPigmentDraftCompositeOpLoc = gl.getUniformLocation(pdProg, 'u_compositeOp');
        state.uPigmentDraftCombineModeLoc = gl.getUniformLocation(pdProg, 'u_combineMode');
        state.uPigmentDraftMaskEnabledLoc = gl.getUniformLocation(pdProg, 'u_maskEnabled');
        state.uPigmentDraftLayerColorEnabledLoc = gl.getUniformLocation(pdProg, 'u_layerColorEnabled');
        state.uPigmentDraftLayerColorLoc = gl.getUniformLocation(pdProg, 'u_layerColor');
        state.uPigmentDraftLayerSubColorLoc = gl.getUniformLocation(pdProg, 'u_layerSubColor');
      } else if (pdProg) {
        console.error('Pigment draft link error:', gl.getProgramInfoLog(pdProg));
      }
    } else if (pigDraftFs) {
      console.error('Pigment draft FS error:', gl.getShaderInfoLog(pigDraftFs));
    }

    // Compile Soft Proof Shader Program
    const proofVs = compileShader(gl, gl.VERTEX_SHADER, SOFT_PROOF_VERTEX_SHADER);
    const proofFs = compileShader(gl, gl.FRAGMENT_SHADER, SOFT_PROOF_FRAGMENT_SHADER);
    if (proofVs && proofFs) {
      if (
        gl.getShaderParameter(proofVs, gl.COMPILE_STATUS) &&
        gl.getShaderParameter(proofFs, gl.COMPILE_STATUS)
      ) {
        const pProg = linkProgram(gl, proofVs, proofFs);
        if (pProg) {
          if (gl.getProgramParameter(pProg, gl.LINK_STATUS)) {
            state.softProofProgram = pProg;
            state.aProofQuadPosLoc = gl.getAttribLocation(pProg, 'a_quadPos');
            state.uProofSceneTextureLoc = gl.getUniformLocation(pProg, 'u_sceneTexture');
            state.uProofStandardLoc = gl.getUniformLocation(pProg, 'u_standard');
            state.uProofEnabledLoc = gl.getUniformLocation(pProg, 'u_proofEnabled');
            state.uProofGamutWarningLoc = gl.getUniformLocation(pProg, 'u_gamutWarning');
            state.uProofGamutWarningColorLoc = gl.getUniformLocation(pProg, 'u_gamutWarningColor');
          } else {
            console.error('Soft proof link error:', gl.getProgramInfoLog(pProg));
          }
        }
      } else {
        console.error(
          'Soft proof shader compile error:',
          gl.getShaderInfoLog(proofVs),
          gl.getShaderInfoLog(proofFs)
        );
      }
    }

    // Compile Frame Border Folder Polygon Program
    const frameVs = compileShader(gl, gl.VERTEX_SHADER, FRAME_POLY_VERTEX_SHADER);
    const frameFs = compileShader(gl, gl.FRAGMENT_SHADER, FRAME_POLY_FRAGMENT_SHADER);
    if (
      frameVs &&
      frameFs &&
      gl.getShaderParameter(frameVs, gl.COMPILE_STATUS) &&
      gl.getShaderParameter(frameFs, gl.COMPILE_STATUS)
    ) {
      const fProg = linkProgram(gl, frameVs, frameFs);
      if (fProg && gl.getProgramParameter(fProg, gl.LINK_STATUS)) {
        state.framePolyProgram = fProg;
        state.aFramePolyDocPosLoc = gl.getAttribLocation(fProg, 'a_docPos');
        state.uFramePolyDocDimensionsLoc = gl.getUniformLocation(fProg, 'u_docDimensions');
        state.uFramePolyViewportSizeLoc = gl.getUniformLocation(fProg, 'u_viewportSize');
        state.uFramePolyPanLoc = gl.getUniformLocation(fProg, 'u_pan');
        state.uFramePolyZoomLoc = gl.getUniformLocation(fProg, 'u_zoom');
        state.uFramePolyRotationRadLoc = gl.getUniformLocation(fProg, 'u_rotationRad');
        state.uFramePolyFlipLoc = gl.getUniformLocation(fProg, 'u_flip');
        state.uFramePolyDprLoc = gl.getUniformLocation(fProg, 'u_dpr');
        state.uFramePolyColorLoc = gl.getUniformLocation(fProg, 'u_color');
        state.framePolyBuffer = gl.createBuffer();
      }
    }

    const unitQuadVerts = new Float32Array([
      0.0, 0.0,
      1.0, 0.0,
      0.0, 1.0,
      0.0, 1.0,
      1.0, 0.0,
      1.0, 1.0,
    ]);

    // Create Layer Styles Quad Buffer [0, 1]
    const stylesQuad = gl.createBuffer();
    if (stylesQuad) {
      gl.bindBuffer(gl.ARRAY_BUFFER, stylesQuad);
      gl.bufferData(gl.ARRAY_BUFFER, unitQuadVerts, gl.STATIC_DRAW);
      state.stylesQuadBuffer = stylesQuad;
    }

    // Create Unit Quad Buffer [0, 1]
    const quad = gl.createBuffer();
    if (!quad) return false;
    gl.bindBuffer(gl.ARRAY_BUFFER, quad);
    gl.bufferData(gl.ARRAY_BUFFER, unitQuadVerts, gl.STATIC_DRAW);
    state.quadBuffer = quad;

    // Initialize TEXTURE_2D_ARRAY + instanced batch rendering pipeline
    initTileArrayPool(state, gl);

    // Enable blending
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);

    return true;
  } catch (err) {
    console.warn('WebGL2 not available for compositor:', err);
    return false;
  }
}
