import { describe, it, expect } from 'vitest';
import {
  calculateVisibleDocumentBounds,
  ViewportTransform,
  COMPOSITOR_VERTEX_SHADER,
  COMPOSITOR_FRAGMENT_SHADER,
  groupLayersForCompositing,
} from '../compositor';
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
});



