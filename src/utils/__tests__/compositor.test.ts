import { describe, it, expect } from 'vitest';
import {
  calculateVisibleDocumentBounds,
  ViewportTransform,
  COMPOSITOR_VERTEX_SHADER,
  COMPOSITOR_FRAGMENT_SHADER,
  COMPOSITOR_INSTANCED_VERTEX_SHADER,
  COMPOSITOR_INSTANCED_FRAGMENT_SHADER,
  VIEWPORT_DRAFT_VERTEX_SHADER,
  BLEND_MODE_MAP,
  groupLayersForCompositing,
  partitionLayerStack,
  isUnitNormalAssociative,
  LayerStackCacheTracker,
  ViewportCompositor,
} from '../compositor';
import { SparseTileGrid } from '../tileEngine';
import { LayerItem } from '../../types/editor';

describe('Unified GPU Viewport Compositor', () => {
  it('accurately calculates frustum culling document bounds under pan and zoom', () => {
    const transform: ViewportTransform = {
      pan: { x: 960, y: 540 }, // Centered in viewport
      zoom: 1.0,
      rotation: 0,
    };

    const docW = 4961;
    const docH = 7016;

    const bounds = calculateVisibleDocumentBounds(
      1920,
      1080,
      transform,
      docW,
      docH
    );

    // Visible width should cover at least 1920 px and height at least 1080 px (with conservative ceil/floor)
    expect(bounds.maxX - bounds.minX).toBeGreaterThanOrEqual(1920);
    expect(bounds.maxX - bounds.minX).toBeLessThanOrEqual(1922);
    expect(bounds.maxY - bounds.minY).toBeGreaterThanOrEqual(1080);
    expect(bounds.maxY - bounds.minY).toBeLessThanOrEqual(1082);

    const centerX = (bounds.minX + bounds.maxX) / 2;
    const centerY = (bounds.minY + bounds.maxY) / 2;

    expect(centerX).toBeCloseTo(docW / 2, 0);
    expect(centerY).toBeCloseTo(docH / 2, 0);
  });

  it('contracts frustum bounds when zooming in (culling more tiles)', () => {
    const transformZoom2: ViewportTransform = {
      pan: { x: 960, y: 540 },
      zoom: 2.0, // Zoomed in 2x
      rotation: 0,
    };

    const bounds = calculateVisibleDocumentBounds(
      1920,
      1080,
      transformZoom2,
      4961,
      7016
    );

    // When zoomed in 2x, visible document area is half as wide and half as tall
    expect(bounds.maxX - bounds.minX).toBeGreaterThanOrEqual(960);
    expect(bounds.maxX - bounds.minX).toBeLessThanOrEqual(962);
    expect(bounds.maxY - bounds.minY).toBeGreaterThanOrEqual(540);
    expect(bounds.maxY - bounds.minY).toBeLessThanOrEqual(542);
  });

  it('correctly maps quad texture coordinates without vertical inversion', () => {
    // Top-left of quad must map to top-left of tile buffer (v_texCoord = a_quadPos)
    expect(COMPOSITOR_VERTEX_SHADER).toContain('v_texCoord = a_quadPos;');
    expect(COMPOSITOR_VERTEX_SHADER).not.toContain('1.0 - a_quadPos.y');
  });

  it('outputs premultiplied alpha in fragment shader for standard GL blend compatibility', () => {
    expect(COMPOSITOR_FRAGMENT_SHADER).toContain('fragColor = vec4(finalColor.rgb * finalColor.a, finalColor.a);');
  });

  it('groups successive clipped layers under their immediate non-clipped base layer', () => {
    const makeLayer = (id: string, clipped: boolean = false): LayerItem => ({
      id,
      name: id,
      type: 'raster',
      visible: true,
      opacity: 1,
      blendMode: 'normal',
      locked: false,
      parentId: null,
      clipped,
    });

    // Stack bottom-to-top: [Base1, Clip1A, Clip1B, Base2, Clip2A, Base3]
    const layers = [
      makeLayer('base-1', false),
      makeLayer('clip-1a', true),
      makeLayer('clip-1b', true),
      makeLayer('base-2', false),
      makeLayer('clip-2a', true),
      makeLayer('base-3', false),
    ];

    const groups = groupLayersForCompositing(layers);
    expect(groups).toHaveLength(3);

    // Group 1: base-1 with [clip-1a, clip-1b]
    expect(groups[0].baseLayer.id).toBe('base-1');
    expect(groups[0].clippedLayers.map((l) => l.id)).toEqual(['clip-1a', 'clip-1b']);

    // Group 2: base-2 with [clip-2a]
    expect(groups[1].baseLayer.id).toBe('base-2');
    expect(groups[1].clippedLayers.map((l) => l.id)).toEqual(['clip-2a']);

    // Group 3: base-3 with no clipped layers
    expect(groups[2].baseLayer.id).toBe('base-3');
    expect(groups[2].clippedLayers).toHaveLength(0);
  });

  describe('Non-Destructive GPU Layer Styles Engine', () => {
    it('accurately identifies active layer styles', async () => {
      const { hasActiveLayerStyles } = await import('../compositor');

      expect(hasActiveLayerStyles(undefined)).toBe(false);
      expect(hasActiveLayerStyles({})).toBe(false);

      // Disabled stroke
      expect(
        hasActiveLayerStyles({
          stroke: { enabled: false, size: 5, color: '#000', position: 'outside', opacity: 1 },
        })
      ).toBe(false);

      // Active stroke
      expect(
        hasActiveLayerStyles({
          stroke: { enabled: true, size: 3, color: '#ff0000', position: 'outside', opacity: 1 },
        })
      ).toBe(true);

      // Active drop shadow
      expect(
        hasActiveLayerStyles({
          dropShadow: { enabled: true, color: '#000000', opacity: 0.8, angle: 90, distance: 5, blur: 10, spread: 0 },
        })
      ).toBe(true);

      // Active outer glow
      expect(
        hasActiveLayerStyles({
          outerGlow: { enabled: true, color: '#ffff00', opacity: 0.9, blur: 15, spread: 20 },
        })
      ).toBe(true);
    });

    it('contains valid Layer Styles shader uniforms and structures', async () => {
      const { LAYER_STYLES_VERTEX_SHADER, LAYER_STYLES_FRAGMENT_SHADER } = await import('../compositor');

      // Vertex shader quad mapping
      expect(LAYER_STYLES_VERTEX_SHADER).toContain('a_quadPos');
      expect(LAYER_STYLES_VERTEX_SHADER).toContain('v_uv');
      expect(LAYER_STYLES_VERTEX_SHADER).toContain('a_quadPos.x * 2.0 - 1.0');

      // Fragment shader uniforms
      expect(LAYER_STYLES_FRAGMENT_SHADER).toContain('u_layerTexture');
      expect(LAYER_STYLES_FRAGMENT_SHADER).toContain('u_strokeEnabled');
      expect(LAYER_STYLES_FRAGMENT_SHADER).toContain('u_strokeSize');
      expect(LAYER_STYLES_FRAGMENT_SHADER).toContain('u_strokePosition');
      expect(LAYER_STYLES_FRAGMENT_SHADER).toContain('u_glowEnabled');
      expect(LAYER_STYLES_FRAGMENT_SHADER).toContain('u_glowBlur');
      expect(LAYER_STYLES_FRAGMENT_SHADER).toContain('u_shadowEnabled');
      expect(LAYER_STYLES_FRAGMENT_SHADER).toContain('u_shadowOffset');
      expect(LAYER_STYLES_FRAGMENT_SHADER).toContain('u_shadowBlur');

      // Photoshop compositing order
      expect(LAYER_STYLES_FRAGMENT_SHADER).toContain('// 1. Drop Shadow Pass');
      expect(LAYER_STYLES_FRAGMENT_SHADER).toContain('// 2. Outer Glow Pass');
      expect(LAYER_STYLES_FRAGMENT_SHADER).toContain('// 3. Stroke Pass');
      expect(LAYER_STYLES_FRAGMENT_SHADER).toContain('POISSON_KERNEL');
    });
  });

  describe('Folder Tree and Pass-Through Compositing Engine', () => {
    it('accurately builds hierarchy trees from flat layer collections', async () => {
      const { buildLayerTree } = await import('../compositor');

      const layers: LayerItem[] = [
        { id: 'folder-1', name: 'Folder 1', type: 'folder', visible: true, opacity: 1, blendMode: 'pass-through', locked: false, parentId: null },
        { id: 'layer-child-1', name: 'Child 1', type: 'raster', visible: true, opacity: 1, blendMode: 'normal', locked: false, parentId: 'folder-1' },
        { id: 'layer-child-2', name: 'Child 2', type: 'raster', visible: true, opacity: 1, blendMode: 'normal', locked: false, parentId: 'folder-1' },
        { id: 'root-layer-2', name: 'Root Layer 2', type: 'raster', visible: true, opacity: 1, blendMode: 'normal', locked: false, parentId: null },
      ];

      const tree = buildLayerTree(layers);
      expect(tree).toHaveLength(2);
      expect(tree[0].layer.id).toBe('folder-1');
      expect(tree[0].children).toHaveLength(2);
      expect(tree[0].children[0].layer.id).toBe('layer-child-1');
      expect(tree[0].children[1].layer.id).toBe('layer-child-2');
      expect(tree[1].layer.id).toBe('root-layer-2');
      expect(tree[1].children).toHaveLength(0);
    });

    it('groups sibling tree nodes respecting clipping masks', async () => {
      const { buildLayerTree, groupTreeNodesForCompositing } = await import('../compositor');

      const layers: LayerItem[] = [
        { id: 'base-1', name: 'Base 1', type: 'raster', visible: true, opacity: 1, blendMode: 'normal', locked: false, parentId: null },
        { id: 'clip-1', name: 'Clip 1', type: 'raster', visible: true, opacity: 1, blendMode: 'normal', locked: false, parentId: null, clipped: true },
        { id: 'base-2', name: 'Base 2', type: 'raster', visible: true, opacity: 1, blendMode: 'normal', locked: false, parentId: null },
      ];

      const tree = buildLayerTree(layers);
      const groups = groupTreeNodesForCompositing(tree);

      expect(groups).toHaveLength(2);
      expect(groups[0].baseNode.layer.id).toBe('base-1');
      expect(groups[0].clippedNodes).toHaveLength(1);
      expect(groups[0].clippedNodes[0].layer.id).toBe('clip-1');
      expect(groups[1].baseNode.layer.id).toBe('base-2');
      expect(groups[1].clippedNodes).toHaveLength(0);
    });

    it('contains folder blit shaders with texture uniforms and pass-through blend support', async () => {
      const { FOLDER_BLIT_VERTEX_SHADER, FOLDER_BLIT_FRAGMENT_SHADER, BLEND_MODE_MAP } = await import('../compositor');

      expect(FOLDER_BLIT_VERTEX_SHADER).toContain('a_quadPos');
      expect(FOLDER_BLIT_FRAGMENT_SHADER).toContain('u_blitTexture');
      expect(FOLDER_BLIT_FRAGMENT_SHADER).toContain('u_blitOpacity');
      expect(BLEND_MODE_MAP['pass-through']).toBe(12);
    });
  });

  describe('CMYK Soft Proofing and Out-of-Gamut Warning Shader', () => {
    it('exports SOFT_PROOF_VERTEX_SHADER and SOFT_PROOF_FRAGMENT_SHADER', async () => {
      const { SOFT_PROOF_VERTEX_SHADER, SOFT_PROOF_FRAGMENT_SHADER } = await import('../compositor');

      expect(SOFT_PROOF_VERTEX_SHADER).toBeDefined();
      expect(SOFT_PROOF_FRAGMENT_SHADER).toBeDefined();
      expect(SOFT_PROOF_VERTEX_SHADER).toContain('a_quadPos');
      expect(SOFT_PROOF_VERTEX_SHADER).toContain('v_uv = a_quadPos;');
    });

    it('contains sRGB to CIE XYZ to Lab color conversion routines in fragment shader', async () => {
      const { SOFT_PROOF_FRAGMENT_SHADER } = await import('../compositor');

      expect(SOFT_PROOF_FRAGMENT_SHADER).toContain('srgbToLinear');
      expect(SOFT_PROOF_FRAGMENT_SHADER).toContain('linearToSrgb');
      expect(SOFT_PROOF_FRAGMENT_SHADER).toContain('linearToXyz');
      expect(SOFT_PROOF_FRAGMENT_SHADER).toContain('xyzToLab');
      expect(SOFT_PROOF_FRAGMENT_SHADER).toContain('srgbToLab');
      // D65 reference white constants
      expect(SOFT_PROOF_FRAGMENT_SHADER).toContain('0.95047');
      expect(SOFT_PROOF_FRAGMENT_SHADER).toContain('1.08883');
    });

    it('evaluates CMYK ink densities and pigment compression for all standards', async () => {
      const { SOFT_PROOF_FRAGMENT_SHADER } = await import('../compositor');

      expect(SOFT_PROOF_FRAGMENT_SHADER).toContain('simulateCmyk');
      expect(SOFT_PROOF_FRAGMENT_SHADER).toContain('u_standard');
      // Japan Color 2001, US Web Coated SWOP, and ISO Coated v2 profiles
      expect(SOFT_PROOF_FRAGMENT_SHADER).toContain('densC');
      expect(SOFT_PROOF_FRAGMENT_SHADER).toContain('densM');
      expect(SOFT_PROOF_FRAGMENT_SHADER).toContain('densY');
      expect(SOFT_PROOF_FRAGMENT_SHADER).toContain('densK');
      expect(SOFT_PROOF_FRAGMENT_SHADER).toContain('tacLimit');
      expect(SOFT_PROOF_FRAGMENT_SHADER).toContain('tvi');
    });

    it('detects out-of-gamut pixels using delta-E > 0.05 and replaces them with warning color', async () => {
      const { SOFT_PROOF_FRAGMENT_SHADER } = await import('../compositor');

      expect(SOFT_PROOF_FRAGMENT_SHADER).toContain('dLab = labOrig - labProof;');
      expect(SOFT_PROOF_FRAGMENT_SHADER).toContain('deltaE = length(dLab) / 100.0;');
      expect(SOFT_PROOF_FRAGMENT_SHADER).toContain('bool isOutOfGamut = (deltaE > 0.05);');
      expect(SOFT_PROOF_FRAGMENT_SHADER).toContain('u_gamutWarningColor');
      expect(SOFT_PROOF_FRAGMENT_SHADER).toContain('outRgb = u_gamutWarningColor;');
    });
  });

  describe('Non-Destructive View Flip (Flip Horizontal / Vertical)', () => {
    it('applies u_flip uniform in vertex shader without mutating texture UVs', () => {
      expect(COMPOSITOR_VERTEX_SHADER).toContain('uniform vec2 u_flip;');
      expect(COMPOSITOR_VERTEX_SHADER).toContain('vec2 centered = (docPos - u_docDimensions * 0.5) * u_flip;');
      expect(COMPOSITOR_VERTEX_SHADER).toContain('v_texCoord = a_quadPos;');
    });

    it('accurately mirrors frustum culling bounds when flipX and flipY are active', () => {
      const docW = 2000;
      const docH = 1600;
      const viewportW = 800;
      const viewportH = 600;

      // Panned so viewport looks at top-left quadrant of unflipped document:
      // Document center (1000, 800) is placed at screen (700, 500), zoom = 1.0
      const unflippedBounds = calculateVisibleDocumentBounds(
        viewportW,
        viewportH,
        { pan: { x: 700, y: 500 }, zoom: 1.0, rotation: 0, flipX: false, flipY: false },
        docW,
        docH
      );
      expect(unflippedBounds).toEqual({
        minX: 300,
        minY: 300,
        maxX: 1100,
        maxY: 900,
      });

      // With flipX = true at the same pan (700, 500), horizontal document region reflects around docW/2 = 1000:
      // [300, 1100] -> [2000 - 1100, 2000 - 300] = [900, 1700]
      const flippedHBounds = calculateVisibleDocumentBounds(
        viewportW,
        viewportH,
        { pan: { x: 700, y: 500 }, zoom: 1.0, rotation: 0, flipX: true, flipY: false },
        docW,
        docH
      );
      expect(flippedHBounds).toEqual({
        minX: 900,
        minY: 300,
        maxX: 1700,
        maxY: 900,
      });

      // With flipY = true as well, vertical document region reflects around docH/2 = 800:
      // [300, 900] -> [1600 - 900, 1600 - 300] = [700, 1300]
      const flippedHVBounds = calculateVisibleDocumentBounds(
        viewportW,
        viewportH,
        { pan: { x: 700, y: 500 }, zoom: 1.0, rotation: 0, flipX: true, flipY: true },
        docW,
        docH
      );
      expect(flippedHVBounds).toEqual({
        minX: 900,
        minY: 700,
        maxX: 1700,
        maxY: 1300,
      });
    });

    it('renders non-destructively in 2D fallback with signed zoom scale while keeping tile grid untouched', async () => {
      const { ViewportCompositor } = await import('../compositor');
      const { SparseTileGrid } = await import('../tileEngine');

      const grid = new SparseTileGrid();
      const pixelBuf = new Uint8ClampedArray(16 * 16 * 4);
      pixelBuf[0] = 240; // R at (0, 0)
      pixelBuf[1] = 32;  // G
      pixelBuf[2] = 64;  // B
      pixelBuf[3] = 255; // A
      grid.writeImageData('layer-1', { data: pixelBuf, width: 16, height: 16 }, 10, 20, 'color-32bit');

      const scaleCalls: Array<[number, number]> = [];
      const mock2DCtx = {
        save: () => {},
        restore: () => {},
        clearRect: () => {},
        scale: (sx: number, sy: number) => {
          scaleCalls.push([sx, sy]);
        },
        translate: () => {},
        rotate: () => {},
        fillRect: () => {},
        drawImage: () => {},
        fillStyle: '#ffffff',
        globalAlpha: 1,
        globalCompositeOperation: 'source-over',
      };

      const mockCanvas = {
        width: 800,
        height: 600,
        getContext: (type: string) => (type === '2d' ? mock2DCtx : null),
      } as unknown as HTMLCanvasElement;

      const compositor = new ViewportCompositor(mockCanvas);
      const layers: LayerItem[] = [
        {
          id: 'layer-1',
          name: 'Ink',
          type: 'raster',
          visible: true,
          opacity: 1,
          blendMode: 'normal',
          locked: false,
          parentId: null,
        },
      ];

      compositor.render(
        layers,
        { pan: { x: 400, y: 300 }, zoom: 2.5, rotation: 15, flipX: true, flipY: false },
        { width: 1000, height: 800 },
        grid,
        { dimensions: { width: 1000, height: 800 }, devicePixelRatio: 1 }
      );

      // Verify signed flip scale (-2.5, 2.5) was applied to viewport transform
      expect(scaleCalls).toContainEqual([-2.5, 2.5]);

      // Verify underlying layer tile pixels were NOT destructively flipped or mutated
      const checkAfter = grid.readImageData('layer-1', 10, 20, 16, 16);
      expect(checkAfter.data[0]).toBe(240);
      expect(checkAfter.data[1]).toBe(32);
      expect(checkAfter.data[2]).toBe(64);
      expect(checkAfter.data[3]).toBe(255);
      // Opposite corner of 16x16 patch remains transparent
      expect(checkAfter.data[(15 * 16 + 15) * 4 + 3]).toBe(0);
    });
  });

  describe('Baked Layer Stack Cache Partitioning & Invalidation (below / above)', () => {
    const makeLayer = (id: string, overrides: Partial<LayerItem> = {}): LayerItem => ({
      id,
      name: id,
      type: 'raster',
      visible: true,
      opacity: 1,
      blendMode: 'normal',
      locked: false,
      parentId: null,
      ...overrides,
    });

    const baseTransform: ViewportTransform = {
      pan: { x: 400, y: 300 },
      zoom: 1.0,
      rotation: 0,
      flipX: false,
      flipY: false,
    };

    const baseDimensions = { width: 1024, height: 1024, dpi: 300 };

    it('keeps both below and above caches valid while editing the active layer', () => {
      // UI top-to-bottom order: layer-9 (top) ... layer-0 (bottom)
      const layers: LayerItem[] = [];
      for (let i = 9; i >= 0; i--) {
        layers.push(makeLayer(`layer-${i}`));
      }

      const versions = new Map<string, number>();
      const getVer = (id: string) => versions.get(id) ?? 0;
      const tracker = new LayerStackCacheTracker();

      const first = tracker.evaluate({
        layers,
        activeLayerId: 'layer-4',
        viewportW: 800,
        viewportH: 600,
        dpr: 1,
        dimensions: baseDimensions,
        transform: baseTransform,
        showCheckerboard: true,
        getLayerContentVersion: getVer,
      });

      expect(first.belowDirty).toBe(true);
      expect(first.aboveDirty).toBe(true);
      expect(first.partition.belowUnits.map((u) => u.group.baseNode.layer.id)).toEqual([
        'layer-0',
        'layer-1',
        'layer-2',
        'layer-3',
      ]);
      expect(first.partition.activeUnit?.group.baseNode.layer.id).toBe('layer-4');
      expect(first.partition.aboveStrategy).toBe('baked-normal');
      expect(first.partition.aboveCachedUnits.map((u) => u.group.baseNode.layer.id)).toEqual([
        'layer-5',
        'layer-6',
        'layer-7',
        'layer-8',
        'layer-9',
      ]);

      tracker.commit(first.belowSignature, first.aboveSignature);

      // Simulate 5 consecutive brush stroke frames mutating ONLY active layer-4
      for (let stroke = 1; stroke <= 5; stroke++) {
        versions.set('layer-4', stroke);
        const evalRes = tracker.evaluate({
          layers,
          activeLayerId: 'layer-4',
          viewportW: 800,
          viewportH: 600,
          dpr: 1,
          dimensions: baseDimensions,
          transform: baseTransform,
          showCheckerboard: true,
          getLayerContentVersion: getVer,
        });
        expect(evalRes.belowDirty).toBe(false);
        expect(evalRes.aboveDirty).toBe(false);
      }
    });

    it('invalidates ONLY below cache when an inactive lower layer changes (content, visibility, opacity, blendMode, mask)', () => {
      const layers = [
        makeLayer('top-2'),
        makeLayer('top-1'),
        makeLayer('active-mid'),
        makeLayer('bot-2'),
        makeLayer('bot-1'),
      ];
      const versions = new Map<string, number>();
      const maskEpochs = new Map<string, number>();
      const tracker = new LayerStackCacheTracker();

      const runEval = (currentLayers: LayerItem[] = layers) =>
        tracker.evaluate({
          layers: currentLayers,
          activeLayerId: 'active-mid',
          viewportW: 800,
          viewportH: 600,
          dpr: 1,
          dimensions: baseDimensions,
          transform: baseTransform,
          showCheckerboard: false,
          getLayerContentVersion: (id) => versions.get(id) ?? 0,
          getMaskInvalidationEpoch: (id) => maskEpochs.get(id) ?? 0,
        });

      const init = runEval();
      tracker.commit(init.belowSignature, init.aboveSignature);

      // 1. Inactive below content edit (e.g. undo/redo or remote peer)
      versions.set('bot-1', 1);
      const afterBotContent = runEval();
      expect(afterBotContent.belowDirty).toBe(true);
      expect(afterBotContent.aboveDirty).toBe(false);
      tracker.commit(afterBotContent.belowSignature, afterBotContent.aboveSignature);

      // 2. Inactive below opacity change
      const opacityLayers = layers.map((l) => (l.id === 'bot-2' ? { ...l, opacity: 0.45 } : l));
      const afterBotOpacity = runEval(opacityLayers);
      expect(afterBotOpacity.belowDirty).toBe(true);
      expect(afterBotOpacity.aboveDirty).toBe(false);
      tracker.commit(afterBotOpacity.belowSignature, afterBotOpacity.aboveSignature);

      // 3. Inactive below visibility toggle
      const visLayers = opacityLayers.map((l) => (l.id === 'bot-1' ? { ...l, visible: false } : l));
      const afterBotVis = runEval(visLayers);
      expect(afterBotVis.belowDirty).toBe(true);
      expect(afterBotVis.aboveDirty).toBe(false);
      tracker.commit(afterBotVis.belowSignature, afterBotVis.aboveSignature);

      // 4. Inactive below blendMode change
      const blendLayers = visLayers.map((l) => (l.id === 'bot-2' ? { ...l, blendMode: 'multiply' as const } : l));
      const afterBotBlend = runEval(blendLayers);
      expect(afterBotBlend.belowDirty).toBe(true);
      expect(afterBotBlend.aboveDirty).toBe(false);
      tracker.commit(afterBotBlend.belowSignature, afterBotBlend.aboveSignature);

      // 5. Inactive below mask change
      const mockMaskCanvas = { width: 1024, height: 1024 } as HTMLCanvasElement;
      const maskLayers = blendLayers.map((l) =>
        l.id === 'bot-2' ? { ...l, maskCanvas: mockMaskCanvas, maskEnabled: true, maskVersion: 1 } : l
      );
      const afterBotMask = runEval(maskLayers);
      expect(afterBotMask.belowDirty).toBe(true);
      expect(afterBotMask.aboveDirty).toBe(false);
      tracker.commit(afterBotMask.belowSignature, afterBotMask.aboveSignature);

      maskEpochs.set('bot-2', 1);
      const afterBotMaskEpoch = runEval(maskLayers);
      expect(afterBotMaskEpoch.belowDirty).toBe(true);
      expect(afterBotMaskEpoch.aboveDirty).toBe(false);
    });

    it('invalidates ONLY above cache when an inactive upper layer changes', () => {
      const layers = [
        makeLayer('top-2'),
        makeLayer('top-1'),
        makeLayer('active-mid'),
        makeLayer('bot-1'),
      ];
      const versions = new Map<string, number>();
      const tracker = new LayerStackCacheTracker();

      const runEval = (currentLayers: LayerItem[] = layers) =>
        tracker.evaluate({
          layers: currentLayers,
          activeLayerId: 'active-mid',
          viewportW: 800,
          viewportH: 600,
          dpr: 1,
          dimensions: baseDimensions,
          transform: baseTransform,
          showCheckerboard: false,
          getLayerContentVersion: (id) => versions.get(id) ?? 0,
        });

      const init = runEval();
      tracker.commit(init.belowSignature, init.aboveSignature);

      // 1. Upper layer pixel content change
      versions.set('top-2', 3);
      const afterTopContent = runEval();
      expect(afterTopContent.belowDirty).toBe(false);
      expect(afterTopContent.aboveDirty).toBe(true);
      tracker.commit(afterTopContent.belowSignature, afterTopContent.aboveSignature);

      // 2. Upper layer opacity change
      const opacityLayers = layers.map((l) => (l.id === 'top-1' ? { ...l, opacity: 0.7 } : l));
      const afterTopOpacity = runEval(opacityLayers);
      expect(afterTopOpacity.belowDirty).toBe(false);
      expect(afterTopOpacity.aboveDirty).toBe(true);
      tracker.commit(afterTopOpacity.belowSignature, afterTopOpacity.aboveSignature);

      // 3. Adding a brand-new layer above active
      const addedLayers = [makeLayer('top-3'), ...opacityLayers];
      const afterAddAbove = runEval(addedLayers);
      expect(afterAddAbove.belowDirty).toBe(false);
      expect(afterAddAbove.aboveDirty).toBe(true);
    });

    it('invalidates both slices on active layer switch or camera transform change, and only below on checkerboard change', () => {
      const layers = [
        makeLayer('layer-2'),
        makeLayer('layer-1'),
        makeLayer('layer-0'),
      ];
      const tracker = new LayerStackCacheTracker();

      const init = tracker.evaluate({
        layers,
        activeLayerId: 'layer-1',
        viewportW: 800,
        viewportH: 600,
        dpr: 1,
        dimensions: baseDimensions,
        transform: baseTransform,
        showCheckerboard: true,
        getLayerContentVersion: () => 0,
      });
      tracker.commit(init.belowSignature, init.aboveSignature);

      // Checkerboard toggle only affects below cache (artboard background is in below)
      const afterCb = tracker.evaluate({
        layers,
        activeLayerId: 'layer-1',
        viewportW: 800,
        viewportH: 600,
        dpr: 1,
        dimensions: baseDimensions,
        transform: baseTransform,
        showCheckerboard: false,
        getLayerContentVersion: () => 0,
      });
      expect(afterCb.belowDirty).toBe(true);
      expect(afterCb.aboveDirty).toBe(false);
      tracker.commit(afterCb.belowSignature, afterCb.aboveSignature);

      // Camera pan/zoom invalidates both caches
      const afterPan = tracker.evaluate({
        layers,
        activeLayerId: 'layer-1',
        viewportW: 800,
        viewportH: 600,
        dpr: 1,
        dimensions: baseDimensions,
        transform: { ...baseTransform, pan: { x: 450, y: 310 } },
        showCheckerboard: false,
        getLayerContentVersion: () => 0,
      });
      expect(afterPan.belowDirty).toBe(true);
      expect(afterPan.aboveDirty).toBe(true);
      tracker.commit(afterPan.belowSignature, afterPan.aboveSignature);

      // Switching active layer from layer-1 -> layer-0 invalidates both below and above
      const afterSwitch = tracker.evaluate({
        layers,
        activeLayerId: 'layer-0',
        viewportW: 800,
        viewportH: 600,
        dpr: 1,
        dimensions: baseDimensions,
        transform: { ...baseTransform, pan: { x: 450, y: 310 } },
        showCheckerboard: false,
        getLayerContentVersion: () => 0,
      });
      expect(afterSwitch.belowDirty).toBe(true);
      expect(afterSwitch.aboveDirty).toBe(true);
      expect(afterSwitch.partition.belowUnits).toHaveLength(0);
      expect(afterSwitch.partition.aboveCachedUnits.map((u) => u.group.baseNode.layer.id)).toEqual([
        'layer-1',
        'layer-2',
      ]);
    });

    it('correctly selects baked-single-blend, mixed, pass-through folder flattening, and isolated folder associativity', () => {
      // Single Multiply layer above active -> baked-single-blend
      const singleMulLayers = [
        makeLayer('shadow', { blendMode: 'multiply', opacity: 0.5 }),
        makeLayer('base'),
      ];
      const p1 = partitionLayerStack(singleMulLayers, 'base');
      expect(p1.aboveStrategy).toBe('baked-single-blend');
      expect(p1.aboveCacheBlendMode).toBe('multiply');
      expect(p1.aboveDynamicUnits).toHaveLength(0);
      expect(p1.aboveCachedUnits).toHaveLength(1);

      // Mixed upper stack: Multiply directly above active, plus 2 Normal layers above that
      const mixedLayers = [
        makeLayer('top-normal-2'),
        makeLayer('top-normal-1'),
        makeLayer('mid-multiply', { blendMode: 'multiply' }),
        makeLayer('active-base'),
      ];
      const p2 = partitionLayerStack(mixedLayers, 'active-base');
      expect(p2.aboveStrategy).toBe('mixed');
      expect(p2.aboveDynamicUnits.map((u) => u.group.baseNode.layer.id)).toEqual(['mid-multiply']);
      expect(p2.aboveCachedUnits.map((u) => u.group.baseNode.layer.id)).toEqual([
        'top-normal-1',
        'top-normal-2',
      ]);

      // Pass-through folder flattens children so active child splits siblings into below & above
      const folderLayers = [
        makeLayer('pt-folder', { type: 'folder', blendMode: 'pass-through', opacity: 0.8 }),
        makeLayer('c-top', { parentId: 'pt-folder' }),
        makeLayer('c-mid', { parentId: 'pt-folder' }),
        makeLayer('c-bot', { parentId: 'pt-folder' }),
      ];
      const p3 = partitionLayerStack(folderLayers, 'c-mid');
      expect(p3.belowUnits.map((u) => u.group.baseNode.layer.id)).toEqual(['c-bot']);
      expect(p3.belowUnits[0].inheritedOpacity).toBeCloseTo(0.8);
      expect(p3.activeUnit?.group.baseNode.layer.id).toBe('c-mid');
      expect(p3.aboveCachedUnits.map((u) => u.group.baseNode.layer.id)).toEqual(['c-top']);

      // Isolated folder with normal blend mode above active IS normal-associative even if children use multiply
      const isoLayers = [
        makeLayer('iso-folder', { type: 'folder', blendMode: 'normal' }),
        makeLayer('iso-child', { parentId: 'iso-folder', blendMode: 'multiply' }),
        makeLayer('active-under'),
      ];
      const p4 = partitionLayerStack(isoLayers, 'active-under');
      expect(p4.aboveStrategy).toBe('baked-normal');
      expect(p4.aboveCachedUnits).toHaveLength(1);
      expect(isUnitNormalAssociative(p4.aboveCachedUnits[0])).toBe(true);
    });
  });

  describe('WebGL2 Compositor Optimization Verification (Ping-Pong FBOs, Instanced Batching, Zero CPU Premultiply, In-Stack Draft)', () => {
    function createMockWebGL2Context(options?: { maxArrayLayers?: number }) {
      const maxArrayLayers = options?.maxArrayLayers ?? 256;
      const calls: Array<{ name: string; args: any[] }> = [];
      let activeProgram: any = null;
      let boundFbo: any = null;
      let activeTexUnit = 0;
      let unpackPremultiplyAlpha = false;
      const boundTex2DByUnit = new Map<number, any>();
      const fboColorAttachment = new WeakMap<object, any>();
      const glSpecErrors: string[] = [];
      const programUniforms = new WeakMap<object, Map<string, any>>();
      const uniformMeta = new WeakMap<object, { prog: object; name: string }>();
      let programId = 1;
      let shaderSourceByObj = new WeakMap<object, string>();
      const programTag = new WeakMap<object, string>();
      const drawEvents: Array<{
        type: 'drawArrays' | 'drawArraysInstanced';
        programTag: string;
        count: number;
        instances?: number;
        uniforms: Record<string, any>;
      }> = [];

      const validateWebGL2DrawState = (tag: string, uMap: Map<string, any>) => {
        // 1. Validate WebGL2 rule: sampler2DArray and sampler2D cannot share the same texture unit
        if (tag === 'instanced') {
          const arrUnit = uMap.get('u_tileArrayTexture') ?? 0;
          const maskUnit = uMap.get('u_maskTexture') ?? 0;
          const backdropUnit = uMap.get('u_backdropTexture') ?? 0;
          if (arrUnit === maskUnit || arrUnit === backdropUnit) {
            glSpecErrors.push(
              `Sampler type collision in ${tag}: u_tileArrayTexture=${arrUnit}, u_maskTexture=${maskUnit}, u_backdropTexture=${backdropUnit}`
            );
          }
        }
        // 2. Validate WebGL2 rule: texture attached to active DRAW_FRAMEBUFFER cannot be bound to any active sampler2D unit
        if (boundFbo) {
          const attachedTex = fboColorAttachment.get(boundFbo);
          if (attachedTex) {
            const sampler2DUniforms =
              tag === 'instanced'
                ? ['u_maskTexture', 'u_backdropTexture']
                : tag === 'blit'
                ? ['u_blitTexture', 'u_backdropTexture']
                : tag === 'standard' || tag === 'viewportDraft'
                ? ['u_tileTexture', 'u_maskTexture', 'u_backdropTexture']
                : [];
            for (const sName of sampler2DUniforms) {
              const unit = uMap.get(sName) ?? 0;
              if (boundTex2DByUnit.get(unit) === attachedTex) {
                glSpecErrors.push(
                  `Feedback loop in ${tag}: sampler ${sName} (unit ${unit}) reads texture attached to bound DRAW_FRAMEBUFFER`
                );
              }
            }
          }
        }
      };

      const gl: any = {
        VERTEX_SHADER: 0x8b31,
        FRAGMENT_SHADER: 0x8b30,
        COMPILE_STATUS: 0x8b81,
        LINK_STATUS: 0x8b82,
        ARRAY_BUFFER: 0x8892,
        STATIC_DRAW: 0x88e4,
        DYNAMIC_DRAW: 0x88e8,
        FLOAT: 0x1406,
        TRIANGLES: 0x0004,
        TEXTURE_2D: 0x0de1,
        TEXTURE_2D_ARRAY: 0x8c1a,
        TEXTURE0: 0x84c0,
        TEXTURE1: 0x84c1,
        TEXTURE2: 0x84c2,
        TEXTURE3: 0x84c3,
        TEXTURE_WRAP_S: 0x2802,
        TEXTURE_WRAP_T: 0x2803,
        TEXTURE_MIN_FILTER: 0x2801,
        TEXTURE_MAG_FILTER: 0x2800,
        CLAMP_TO_EDGE: 0x812f,
        LINEAR: 0x2601,
        LINEAR_MIPMAP_LINEAR: 0x2703,
        NEAREST: 0x2600,
        RGBA: 0x1908,
        RGBA8: 0x8058,
        UNSIGNED_BYTE: 0x1401,
        BLEND: 0x0be2,
        STENCIL_TEST: 0x0b90,
        ONE: 1,
        ZERO: 0,
        ONE_MINUS_SRC_ALPHA: 0x0303,
        COLOR_BUFFER_BIT: 0x4000,
        STENCIL_BUFFER_BIT: 0x0400,
        FRAMEBUFFER: 0x8d40,
        READ_FRAMEBUFFER: 0x8ca8,
        DRAW_FRAMEBUFFER: 0x8ca9,
        FRAMEBUFFER_BINDING: 0x8ca6,
        COLOR_ATTACHMENT0: 0x8ce0,
        STENCIL_ATTACHMENT: 0x8d20,
        RENDERBUFFER: 0x8d41,
        STENCIL_INDEX8: 0x8d48,
        FRAMEBUFFER_COMPLETE: 0x8cd5,
        ALWAYS: 0x0207,
        EQUAL: 0x0202,
        KEEP: 0x1e00,
        REPLACE: 0x1e01,
        UNPACK_PREMULTIPLY_ALPHA_WEBGL: 0x9241,
        MAX_ARRAY_TEXTURE_LAYERS: 0x88ff,

        createShader: (type: number) => ({ __shader: type }),
        shaderSource: (shader: object, src: string) => {
          shaderSourceByObj.set(shader, src);
        },
        compileShader: () => {},
        getShaderParameter: () => true,
        getShaderInfoLog: () => '',
        createProgram: () => {
          const p = { id: programId++, shaders: [] as string[] };
          programUniforms.set(p, new Map());
          return p;
        },
        attachShader: (prog: any, shader: object) => {
          const src = shaderSourceByObj.get(shader) || '';
          prog.shaders.push(src);
          if (src === COMPOSITOR_INSTANCED_VERTEX_SHADER) programTag.set(prog, 'instanced');
          else if (src === VIEWPORT_DRAFT_VERTEX_SHADER) programTag.set(prog, 'viewportDraft');
          else if (src === COMPOSITOR_VERTEX_SHADER && !programTag.has(prog)) programTag.set(prog, 'standard');
          else if (src.includes('u_blitTexture')) programTag.set(prog, 'blit');
          else if (src.includes('u_sceneTexture')) programTag.set(prog, 'softProof');
          else if (src.includes('u_lutTexture')) programTag.set(prog, 'adjustment');
          else if (src.includes('POISSON_KERNEL')) programTag.set(prog, 'styles');
        },
        linkProgram: () => {},
        getProgramParameter: () => true,
        getProgramInfoLog: () => '',
        getUniformLocation: (prog: object, name: string) => {
          const loc = { prog, name };
          uniformMeta.set(loc, { prog, name });
          return loc;
        },
        getAttribLocation: (_prog: object, name: string) => (name === 'a_instanceData' ? 1 : 0),
        useProgram: (prog: any) => {
          activeProgram = prog;
        },
        createBuffer: () => ({ __buf: true }),
        bindBuffer: () => {},
        bufferData: () => {},
        bufferSubData: (...args: any[]) => calls.push({ name: 'bufferSubData', args }),
        createVertexArray: () => ({ __vao: true }),
        bindVertexArray: () => {},
        deleteVertexArray: () => {},
        enableVertexAttribArray: () => {},
        disableVertexAttribArray: () => {},
        vertexAttribPointer: () => {},
        vertexAttribDivisor: () => {},
        createTexture: () => ({ __tex: Math.random() }),
        deleteTexture: () => {},
        activeTexture: (unit: number) => {
          activeTexUnit = unit - 0x84c0;
        },
        bindTexture: (...args: any[]) => {
          calls.push({ name: 'bindTexture', args });
          if (args[0] === 0x0de1) {
            boundTex2DByUnit.set(activeTexUnit, args[1]);
          }
        },
        texParameteri: (...args: any[]) => calls.push({ name: 'texParameteri', args }),
        generateMipmap: (...args: any[]) => calls.push({ name: 'generateMipmap', args }),
        texImage2D: (...args: any[]) => calls.push({ name: 'texImage2D', args }),
        texSubImage2D: (...args: any[]) => calls.push({ name: 'texSubImage2D', args }),
        texStorage3D: (...args: any[]) => calls.push({ name: 'texStorage3D', args }),
        texSubImage3D: (...args: any[]) => {
          if (unpackPremultiplyAlpha && ArrayBuffer.isView(args[10])) {
            glSpecErrors.push(
              'GL_INVALID_OPERATION (1282): texSubImage3D with ArrayBufferView cannot use UNPACK_PREMULTIPLY_ALPHA_WEBGL=true'
            );
          }
          calls.push({ name: 'texSubImage3D', args });
        },
        copyTexSubImage2D: (...args: any[]) => calls.push({ name: 'copyTexSubImage2D', args }),
        pixelStorei: (...args: any[]) => {
          if (args[0] === 0x9241) unpackPremultiplyAlpha = Boolean(args[1]);
          calls.push({ name: 'pixelStorei', args });
        },
        createFramebuffer: () => ({ __fbo: Math.random() }),
        deleteFramebuffer: () => {},
        bindFramebuffer: (target: number, fbo: any) => {
          if (target === 0x8d40 || target === 0x8ca9) boundFbo = fbo;
        },
        framebufferTexture2D: (_target: number, attachment: number, _textarget: number, tex: any) => {
          if (boundFbo && attachment === 0x8ce0) {
            fboColorAttachment.set(boundFbo, tex);
          }
        },
        checkFramebufferStatus: () => 0x8cd5,
        blitFramebuffer: (...args: any[]) => calls.push({ name: 'blitFramebuffer', args }),
        createRenderbuffer: () => ({ __rb: true }),
        deleteRenderbuffer: () => {},
        bindRenderbuffer: () => {},
        renderbufferStorage: () => {},
        framebufferRenderbuffer: () => {},
        getParameter: (pname: number) => {
          if (pname === 0x8ca6) return boundFbo;
          if (pname === 0x88ff) return maxArrayLayers;
          return 0;
        },
        viewport: () => {},
        clearColor: () => {},
        clear: () => {},
        enable: () => {},
        disable: () => {},
        isEnabled: () => false,
        blendFunc: () => {},
        stencilMask: () => {},
        stencilFunc: () => {},
        stencilOp: () => {},
        colorMask: () => {},
        uniform1i: (loc: any, v: number) => {
          const meta = loc && uniformMeta.get(loc);
          if (meta) programUniforms.get(meta.prog)?.set(meta.name, v);
        },
        uniform1f: (loc: any, v: number) => {
          const meta = loc && uniformMeta.get(loc);
          if (meta) programUniforms.get(meta.prog)?.set(meta.name, v);
        },
        uniform2f: () => {},
        uniform3f: () => {},
        uniform4f: () => {},
        drawArrays: (_mode: number, _first: number, count: number) => {
          calls.push({ name: 'drawArrays', args: [_mode, _first, count] });
          const tag = (activeProgram && programTag.get(activeProgram)) || 'unknown';
          const uMap = (activeProgram && programUniforms.get(activeProgram)) || new Map();
          validateWebGL2DrawState(tag, uMap);
          drawEvents.push({
            type: 'drawArrays',
            programTag: tag,
            count,
            uniforms: Object.fromEntries(uMap.entries()),
          });
        },
        drawArraysInstanced: (_mode: number, _first: number, count: number, instances: number) => {
          calls.push({ name: 'drawArraysInstanced', args: [_mode, _first, count, instances] });
          const tag = (activeProgram && programTag.get(activeProgram)) || 'unknown';
          const uMap = (activeProgram && programUniforms.get(activeProgram)) || new Map();
          validateWebGL2DrawState(tag, uMap);
          drawEvents.push({
            type: 'drawArraysInstanced',
            programTag: tag,
            count,
            instances,
            uniforms: Object.fromEntries(uMap.entries()),
          });
        },
        deleteBuffer: () => {},
        deleteProgram: () => {},
      };

      const canvas = {
        width: 800,
        height: 600,
        getContext: (type: string) => (type === 'webgl2' ? gl : null),
      } as unknown as HTMLCanvasElement;

      return { gl, canvas, calls, drawEvents, glSpecErrors };
    }

    const writeTestPixel = (grid: SparseTileGrid, layerId: string, x: number, y: number, rgba = [200, 100, 50, 128]) => {
      const buf = new Uint8ClampedArray(16 * 16 * 4);
      for (let i = 0; i < 16 * 16; i++) {
        buf[i * 4] = rgba[0];
        buf[i * 4 + 1] = rgba[1];
        buf[i * 4 + 2] = rgba[2];
        buf[i * 4 + 3] = rgba[3];
      }
      grid.writeImageData(layerId, { data: buf, width: 16, height: 16 }, x, y, 'color-32bit', true);
    };

    it('executes ZERO copyTexSubImage2D calls with 15+ Multiply/Overlay/Color-Dodge layers while rendering and drawing', () => {
      const { canvas, calls } = createMockWebGL2Context();
      const compositor = new ViewportCompositor(canvas);
      const grid = new SparseTileGrid();

      const blendModes: LayerItem['blendMode'][] = [
        'multiply',
        'overlay',
        'screen',
        'color-dodge',
        'hard-light',
        'soft-light',
      ];
      const layers: LayerItem[] = [];
      for (let i = 15; i >= 0; i--) {
        const id = `layer-${i}`;
        layers.push({
          id,
          name: id,
          type: 'raster',
          visible: true,
          opacity: 0.85,
          blendMode: i === 0 ? 'normal' : blendModes[i % blendModes.length],
          locked: false,
          parentId: null,
        });
        writeTestPixel(grid, id, 100, 100);
      }

      const transform: ViewportTransform = { pan: { x: 400, y: 300 }, zoom: 1.0, rotation: 0 };
      const dims = { width: 1024, height: 1024 };

      // Frame 1: Full render across all 16 layers with custom blend modes
      compositor.render(layers, transform, dims, grid, {
        dimensions: dims,
        devicePixelRatio: 1,
        activeLayerId: 'layer-8',
      });

      // Frames 2..6: Live drawing on active layer-8
      for (let step = 0; step < 5; step++) {
        writeTestPixel(grid, 'layer-8', 120 + step * 10, 120);
        compositor.render(layers, transform, dims, grid, {
          dimensions: dims,
          devicePixelRatio: 1,
          activeLayerId: 'layer-8',
        });
      }

      const copyCalls = calls.filter((c) => c.name === 'copyTexSubImage2D');
      const blitCalls = calls.filter((c) => c.name === 'blitFramebuffer');
      expect(copyCalls.length).toBe(0);
      expect(blitCalls.length).toBeGreaterThan(0);
    });

    it('enforces zero WebGL2 sampler-type collisions and zero FBO feedback loops across multi-frame rendering', () => {
      const { canvas, glSpecErrors } = createMockWebGL2Context();
      const compositor = new ViewportCompositor(canvas);
      const grid = new SparseTileGrid();

      const layers: LayerItem[] = [
        {
          id: 'layer-1',
          name: 'Layer 1',
          type: 'raster',
          visible: true,
          opacity: 1,
          blendMode: 'normal',
          locked: false,
          parentId: null,
        },
        {
          id: 'layer-bg',
          name: 'Paper',
          type: 'raster',
          visible: true,
          opacity: 1,
          blendMode: 'normal',
          locked: false,
          parentId: null,
        },
      ];
      grid.fillLayerSolidWhite('layer-bg', 800, 600, 'color-32bit');
      writeTestPixel(grid, 'layer-1', 100, 100, [0, 0, 0, 255]);

      const transform: ViewportTransform = { pan: { x: 400, y: 300 }, zoom: 1.0, rotation: 0 };
      const dims = { width: 800, height: 600 };

      for (let frame = 0; frame < 4; frame++) {
        writeTestPixel(grid, 'layer-1', 100 + frame * 16, 100, [0, 0, 0, 255]);
        compositor.render(layers, transform, dims, grid, {
          dimensions: dims,
          devicePixelRatio: 1,
          showCheckerboard: true,
          activeLayerId: 'layer-1',
        });
      }

      expect(glSpecErrors).toEqual([]);
    });

    it('hits baked below/above stack caches while drawing on active layer in a 25-layer stack', () => {
      const { canvas, drawEvents } = createMockWebGL2Context();
      const compositor = new ViewportCompositor(canvas);
      const grid = new SparseTileGrid();

      const layers: LayerItem[] = [];
      for (let i = 24; i >= 0; i--) {
        const id = `layer-${i}`;
        layers.push({
          id,
          name: id,
          type: 'raster',
          visible: true,
          opacity: 1,
          blendMode: i < 12 && i % 2 === 1 ? 'multiply' : 'normal',
          locked: false,
          parentId: null,
        });
        writeTestPixel(grid, id, 100, 100);
      }

      const transform: ViewportTransform = { pan: { x: 400, y: 300 }, zoom: 1.0, rotation: 0 };
      const dims = { width: 1024, height: 1024 };

      // Cold render builds below & above caches once
      compositor.render(layers, transform, dims, grid, {
        dimensions: dims,
        devicePixelRatio: 1,
        activeLayerId: 'layer-12',
      });
      expect(compositor.getStackCacheStats()).toEqual({
        belowRebuilds: 1,
        aboveRebuilds: 1,
        cacheHits: 0,
      });

      // Hot drawing frame on active layer-12
      drawEvents.length = 0;
      writeTestPixel(grid, 'layer-12', 140, 140);
      compositor.render(layers, transform, dims, grid, {
        dimensions: dims,
        devicePixelRatio: 1,
        activeLayerId: 'layer-12',
      });

      expect(compositor.getStackCacheStats()).toEqual({
        belowRebuilds: 1,
        aboveRebuilds: 1,
        cacheHits: 1,
      });
      // Only 3 shader draws on the hot path: active layer instanced batch + above cache blit + screen present
      expect(drawEvents.length).toBe(3);
      expect(drawEvents[0].type).toBe('drawArraysInstanced');
      expect(drawEvents[0].programTag).toBe('instanced');
      expect(drawEvents[1].programTag).toBe('blit');
      expect(drawEvents[2].programTag).toBe('blit');
    });

    it('batches visible tiles into a single drawArraysInstanced call and falls back cleanly on TEXTURE_2D_ARRAY overflow', () => {
      // 1. Batched fast path (pool capacity 256, 6 visible tiles -> 1 instanced draw call)
      const batchedMock = createMockWebGL2Context({ maxArrayLayers: 256 });
      const batchedCompositor = new ViewportCompositor(batchedMock.canvas);
      const grid = new SparseTileGrid();
      const layers: LayerItem[] = [
        {
          id: 'layer-grid',
          name: 'Grid',
          type: 'raster',
          visible: true,
          opacity: 1,
          blendMode: 'normal',
          locked: false,
          parentId: null,
        },
      ];
      // Write 6 distinct 256x256 tiles inside the visible viewport
      writeTestPixel(grid, 'layer-grid', 10, 10);
      writeTestPixel(grid, 'layer-grid', 270, 10);
      writeTestPixel(grid, 'layer-grid', 530, 10);
      writeTestPixel(grid, 'layer-grid', 10, 270);
      writeTestPixel(grid, 'layer-grid', 270, 270);
      writeTestPixel(grid, 'layer-grid', 530, 270);

      const transform: ViewportTransform = { pan: { x: 400, y: 300 }, zoom: 1.0, rotation: 0 };
      const dims = { width: 800, height: 600 };

      batchedCompositor.render(layers, transform, dims, grid, {
        dimensions: dims,
        devicePixelRatio: 1,
        activeLayerId: 'layer-grid',
      });

      const instancedDraws = batchedMock.drawEvents.filter((e) => e.type === 'drawArraysInstanced');
      expect(instancedDraws.length).toBe(1);
      expect(instancedDraws[0].instances).toBe(6);
      // texSubImage3D MUST NOT use UNPACK_PREMULTIPLY_ALPHA_WEBGL=true (WebGL2 GL_INVALID_OPERATION)
      expect(batchedMock.glSpecErrors).toEqual([]);
      // Verify TileBuffer straight-alpha data was preserved without CPU premultiplication mutation
      const readBack = grid.readImageData('layer-grid', 10, 10, 1, 1);
      expect(Array.from(readBack.data)).toEqual([200, 100, 50, 128]);

      // 2. Overflow fallback (pool capacity = 2, 6 visible tiles -> falls back to 6 standard TEXTURE_2D drawArrays)
      const overflowMock = createMockWebGL2Context({ maxArrayLayers: 2 });
      const overflowCompositor = new ViewportCompositor(overflowMock.canvas);
      overflowCompositor.render(layers, transform, dims, grid, {
        dimensions: dims,
        devicePixelRatio: 1,
        activeLayerId: 'layer-grid',
      });

      const overflowInstanced = overflowMock.drawEvents.filter((e) => e.type === 'drawArraysInstanced');
      const standardTileDraws = overflowMock.drawEvents.filter(
        (e) => e.type === 'drawArrays' && e.programTag === 'standard' && e.uniforms.u_isBackground === 0
      );
      expect(overflowInstanced.length).toBe(0);
      expect(standardTileDraws.length).toBe(6);
      expect(overflowMock.glSpecErrors).toEqual([]);
      const fallbackPremulOn = overflowMock.calls.some(
        (c) => c.name === 'pixelStorei' && c.args[0] === 0x9241 && c.args[1] === true
      );
      expect(fallbackPremulOn).toBe(true);
    });

    it('composites activeDraftCanvas in-stack UNDERNEATH an upper semi-transparent Multiply layer', () => {
      const { canvas, calls, drawEvents } = createMockWebGL2Context();
      const compositor = new ViewportCompositor(canvas);
      const grid = new SparseTileGrid();

      const layers: LayerItem[] = [
        {
          id: 'layer-upper-mul',
          name: 'Shadow Multiply',
          type: 'raster',
          visible: true,
          opacity: 0.5,
          blendMode: 'multiply',
          locked: false,
          parentId: null,
        },
        {
          id: 'layer-lower-active',
          name: 'Base Lineart',
          type: 'raster',
          visible: true,
          opacity: 1.0,
          blendMode: 'normal',
          locked: false,
          parentId: null,
        },
      ];
      writeTestPixel(grid, 'layer-upper-mul', 100, 100, [50, 80, 200, 255]);
      writeTestPixel(grid, 'layer-lower-active', 100, 100, [240, 200, 160, 255]);

      const mockDraftCanvas = {
        width: 800,
        height: 600,
        __draftHasContent: true,
        __draftVersion: 1,
      } as unknown as HTMLCanvasElement;

      const transform: ViewportTransform = { pan: { x: 400, y: 300 }, zoom: 1.0, rotation: 0 };
      const dims = { width: 800, height: 600 };

      // First render to warm below/above caches
      compositor.render(layers, transform, dims, grid, {
        dimensions: dims,
        devicePixelRatio: 1,
        activeLayerId: 'layer-lower-active',
        activeDraftLayerId: 'layer-lower-active',
        activeDraftCanvas: mockDraftCanvas,
        activeDraftVersion: 1,
        activeDraftSpace: 'viewport',
        activeDraftOpacity: 1.0,
      });

      // Second render simulates next live stroke dab on lower layer
      drawEvents.length = 0;
      (mockDraftCanvas as any).__draftVersion = 2;
      compositor.render(layers, transform, dims, grid, {
        dimensions: dims,
        devicePixelRatio: 1,
        activeLayerId: 'layer-lower-active',
        activeDraftLayerId: 'layer-lower-active',
        activeDraftCanvas: mockDraftCanvas,
        activeDraftVersion: 2,
        activeDraftSpace: 'viewport',
        activeDraftOpacity: 1.0,
      });

      // Verify exact rendering order:
      // 0: active lower layer tiles (instanced)
      // 1: activeDraftCanvas (viewportDraft) — INSIDE the stack on layer-lower-active
      // 2: baked upper Multiply layer (blit with u_blendMode = multiply(1), u_hasBackdrop = 1) — ON TOP of live stroke!
      // 3: final present to screen (blit with u_blendMode = 0)
      const draftIdx = drawEvents.findIndex((e) => e.programTag === 'viewportDraft');
      const upperMulIdx = drawEvents.findIndex(
        (e) =>
          e.programTag === 'blit' &&
          e.uniforms.u_blendMode === BLEND_MODE_MAP['multiply'] &&
          e.uniforms.u_hasBackdrop === 1
      );
      expect(draftIdx).toBeGreaterThanOrEqual(0);
      expect(upperMulIdx).toBeGreaterThan(draftIdx);

      // Zero copyTexSubImage2D calls throughout!
      expect(calls.filter((c) => c.name === 'copyTexSubImage2D').length).toBe(0);

      // Sanity check exported instanced shaders
      expect(COMPOSITOR_INSTANCED_VERTEX_SHADER).toContain('in vec3 a_instanceData;');
      expect(COMPOSITOR_INSTANCED_FRAGMENT_SHADER).toContain('sampler2DArray u_tileArrayTexture');
    });

    it('generates trilinear mipmaps for document-space activeDraftCanvas and matches 0.5 monochrome threshold', () => {
      const { canvas, calls } = createMockWebGL2Context();
      const compositor = new ViewportCompositor(canvas);
      const grid = new SparseTileGrid();

      const layers: LayerItem[] = [
        {
          id: 'layer-1',
          name: 'Layer 1',
          type: 'raster',
          visible: true,
          opacity: 1.0,
          blendMode: 'normal',
          locked: false,
          parentId: null,
          expressionColor: 'monochrome',
        },
      ];
      writeTestPixel(grid, 'layer-1', 100, 100, [0, 0, 0, 255]);

      const mockDraftCanvas = {
        width: 1024,
        height: 1024,
        __draftHasContent: true,
        __draftVersion: 1,
        __draftSpace: 'document',
        __draftDocRect: { x: 0, y: 0, width: 2048, height: 2048 },
      } as unknown as HTMLCanvasElement;

      const transform: ViewportTransform = { pan: { x: 400, y: 300 }, zoom: 0.15, rotation: 0 };
      const dims = { width: 2048, height: 2048 };

      compositor.render(layers, transform, dims, grid, {
        dimensions: dims,
        devicePixelRatio: 1,
        activeLayerId: 'layer-1',
        activeDraftLayerId: 'layer-1',
        activeDraftCanvas: mockDraftCanvas,
        activeDraftVersion: 1,
        activeDraftSpace: 'document',
        activeDraftOpacity: 1.0,
      });

      expect(calls.some((c) => c.name === 'generateMipmap')).toBe(true);
      expect(
        calls.some(
          (c) => c.name === 'texParameteri' && c.args[1] === 0x2801 && c.args[2] === 0x2703
        )
      ).toBe(true);
      expect(COMPOSITOR_FRAGMENT_SHADER).toContain('step(0.5, finalColor.a)');
      expect(COMPOSITOR_INSTANCED_FRAGMENT_SHADER).toContain('step(0.5, finalColor.a)');
    });

    it('renders 6071x8598 manga canvas with zero empty-tile LOD thrashing, fast solid-tile LOD pyramid, and texSubImage2D draft updates', () => {
      const { canvas, calls, glSpecErrors } = createMockWebGL2Context({ maxArrayLayers: 512 });
      const compositor = new ViewportCompositor(canvas);
      const grid = new SparseTileGrid();
      const dims = { width: 6071, height: 8598, dpi: 600 };

      // Solid white background (816 LOD 0 tiles) + completely empty ink layer
      grid.fillLayerSolidWhite('layer-bg', dims.width, dims.height, 'color-32bit');
      grid.setLayerFormat('layer-ink', 'monochrome-1bit');

      const layers: LayerItem[] = [
        {
          id: 'layer-ink',
          name: 'Ink',
          type: 'raster',
          visible: true,
          opacity: 1,
          blendMode: 'normal',
          locked: false,
          parentId: null,
          expressionColor: 'monochrome',
        },
        {
          id: 'layer-bg',
          name: 'Paper',
          type: 'raster',
          visible: true,
          opacity: 1,
          blendMode: 'normal',
          locked: false,
          parentId: null,
        },
      ];

      // Fit-to-screen zoom (~0.10 -> LOD 3)
      const fitTransform: ViewportTransform = { pan: { x: 400, y: 300 }, zoom: 0.1, rotation: 0 };
      const t0 = performance.now();
      compositor.render(layers, fitTransform, dims, grid, {
        dimensions: dims,
        devicePixelRatio: 1,
        activeLayerId: 'layer-ink',
      });
      const firstFrameMs = performance.now() - t0;

      // Empty ink layer must have 0 tiles and 0 populated LOD entries
      expect(grid.hasLayerTiles('layer-ink')).toBe(false);
      expect(grid.hasPopulatedLodTile('layer-ink', 0, 0, 3)).toBe(false);
      // Solid-tile fast path should build LOD 3 for 6071x8598 rapidly
      expect(firstFrameMs).toBeLessThan(250);

      // 30 consecutive live-draft frames on empty ink layer at zoom = 1.0 must reuse texSubImage2D & skip mipmaps
      const mockDraftCanvas = {
        width: 512,
        height: 512,
        __draftHasContent: true,
        __draftVersion: 1,
        __draftSpace: 'document',
        __draftDocRect: { x: 0, y: 0, width: 512, height: 512 },
      } as unknown as HTMLCanvasElement;

      const zoom1Transform: ViewportTransform = { pan: { x: 400, y: 300 }, zoom: 1.0, rotation: 0 };
      compositor.render(layers, zoom1Transform, dims, grid, {
        dimensions: dims,
        devicePixelRatio: 1,
        activeLayerId: 'layer-ink',
        activeDraftLayerId: 'layer-ink',
        activeDraftCanvas: mockDraftCanvas,
        activeDraftVersion: 1,
        activeDraftSpace: 'document',
        activeDraftOpacity: 1.0,
      });

      calls.length = 0;
      for (let v = 2; v <= 10; v++) {
        (mockDraftCanvas as any).__draftVersion = v;
        compositor.render(layers, zoom1Transform, dims, grid, {
          dimensions: dims,
          devicePixelRatio: 1,
          activeLayerId: 'layer-ink',
          activeDraftLayerId: 'layer-ink',
          activeDraftCanvas: mockDraftCanvas,
          activeDraftVersion: v,
          activeDraftSpace: 'document',
          activeDraftOpacity: 1.0,
        });
      }

      expect(calls.filter((c) => c.name === 'texSubImage2D').length).toBe(9);
      expect(calls.filter((c) => c.name === 'texImage2D').length).toBe(0);
      expect(calls.filter((c) => c.name === 'generateMipmap').length).toBe(0);
      expect(glSpecErrors).toEqual([]);
      // Instanced fragment shader uses single hardware texture() fetch instead of 4x manual texelFetch
      expect(COMPOSITOR_INSTANCED_FRAGMENT_SHADER).toContain('texture(u_tileArrayTexture, vec3(v_texCoord, v_sliceIndex))');
      expect(COMPOSITOR_INSTANCED_FRAGMENT_SHADER).not.toContain('texelFetch');
    });

    it('uses unified TEXTURE_2D_ARRAY instanced path with STREAM_DRAW buffer orphaning during live eraser strokes', () => {
      const { gl, calls, glSpecErrors } = createMockWebGL2Context();
      const mockCanvas = {
        width: 800,
        height: 600,
        getContext: (type: string) => (type === 'webgl2' ? gl : null),
      } as unknown as HTMLCanvasElement;

      const compositor = new ViewportCompositor(mockCanvas);
      const grid = new SparseTileGrid();
      const dims = { width: 1024, height: 1024, dpi: 300 };

      const tilePx = new Uint8ClampedArray(64 * 64 * 4);
      tilePx.fill(255);
      grid.writeImageData('layer-1', { data: tilePx, width: 64, height: 64 }, 10, 10, 'color-32bit');
      grid.writeImageData('layer-1', { data: tilePx, width: 64, height: 64 }, 300, 300, 'color-32bit');

      const layers: LayerItem[] = [
        {
          id: 'layer-1',
          name: 'Lineart',
          type: 'raster',
          visible: true,
          opacity: 1,
          blendMode: 'normal',
          locked: false,
          parentId: null,
        },
      ];

      const mockEraserDraft = {
        width: 256,
        height: 256,
        __draftHasContent: true,
        __draftCompositeOp: 'destination-out',
        __draftVersion: 1,
        __draftSpace: 'document',
        __draftDocRect: { x: 0, y: 0, width: 256, height: 256 },
      } as unknown as HTMLCanvasElement;

      const transform: ViewportTransform = { pan: { x: 400, y: 300 }, zoom: 1.0, rotation: 0 };

      calls.length = 0;
      compositor.render(layers, transform, dims, grid, {
        dimensions: dims,
        devicePixelRatio: 1,
        activeLayerId: 'layer-1',
        activeDraftLayerId: 'layer-1',
        activeDraftCanvas: mockEraserDraft,
        activeDraftVersion: 1,
        activeDraftSpace: 'document',
        activeDraftOpacity: 1.0,
      });

      // Live eraser isolated FBO must use drawArraysInstanced (same TEXTURE_2D_ARRAY pool as normal rendering)
      expect(calls.some((c) => c.name === 'drawArraysInstanced')).toBe(true);
      // Must orphan instance buffer via bufferData (STREAM_DRAW), never bufferSubData hazard
      expect(calls.some((c) => c.name === 'bufferSubData')).toBe(false);
      // Must not clobber tile.dirty on shared TileBuffer
      const t00 = grid.getTile('layer-1', 0, 0, 0)!;
      expect(t00.dirty).toBe(true);
      expect(glSpecErrors).toEqual([]);
    });
  });
});



