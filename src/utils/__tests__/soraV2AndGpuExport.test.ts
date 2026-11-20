import { describe, it, expect, vi, afterEach } from 'vitest';
import { zipSync, unzipSync } from 'fflate';
import {
  AnimationTimeline,
  LayerItem,
  TextLayerData,
  VectorStroke,
} from '../../types/editor';
import type { PerspectiveRuler } from '../../types/perspective';
import { createDefaultSpeechBalloon } from '../balloonEngine';
import { createRectFrame } from '../frameEngine';
import {
  SparseTileGrid,
  InMemoryScratchDiskDriver,
  BYTES_1BIT,
  BYTES_8BIT,
  BYTES_32BIT,
  setPixel1Bit,
  getPixel1Bit,
} from '../tileEngine';
import { ViewportCompositor } from '../compositor';
import {
  buildGpuExportTilePlan,
  buildSoraProjectPayload,
  compositeCanvas,
  compositeCanvasAsync,
  computeMaxLayerStyleMargin,
  createDocumentRegionRenderer,
  exportImage,
  extractSoraPreview,
  isSoraV2Bytes,
  parseSoraProject,
  SaveProgress,
  serializeDocument,
  serializeSoraV2,
} from '../saveManager';

function createMockMaskCanvas(width: number, height: number, fillFn: (x: number, y: number) => number): HTMLCanvasElement {
  const rgba = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const v = fillFn(x, y);
      const off = (y * width + x) * 4;
      rgba[off] = v;
      rgba[off + 1] = v;
      rgba[off + 2] = v;
      rgba[off + 3] = 255;
    }
  }
  return {
    width,
    height,
    getContext: (type: string) =>
      type === '2d'
        ? {
            getImageData: () => ({ data: rgba, width, height }),
          }
        : null,
  } as unknown as HTMLCanvasElement;
}

describe('.sora v2 Binary Format & Round-Trip Serialization', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('round-trips 1-bit, 8-bit, 32-bit native SparseTileGrid tiles, masks, vectors, text, balloons, frames, perspective, animation, and timelapse without toDataURL', async () => {
    const grid = new SparseTileGrid();

    // 1. 1-bit monochrome ink tile at (2, 3)
    const monoTile = grid.getOrCreateTile('layer-mono', 2, 3, 'monochrome-1bit', 0);
    setPixel1Bit(monoTile.data!, 5, 7, 1);
    setPixel1Bit(monoTile.data!, 200, 123, 1);
    monoTile.version = 9;
    grid.setLayerFormat('layer-mono', 'monochrome-1bit');

    // 2. 8-bit grayscale tone tile at (0, 1)
    const grayTile = grid.getOrCreateTile('layer-gray', 0, 1, 'grayscale-8bit', 0);
    grayTile.data![0] = 42;
    grayTile.data![256 * 10 + 15] = 199;
    grayTile.data![BYTES_8BIT - 1] = 255;
    grayTile.version = 4;
    grid.setLayerFormat('layer-gray', 'grayscale-8bit');

    // 3. 32-bit RGBA color tile at (1, 0) + negative/offset tile at (4, 5)
    const colorTile = grid.getOrCreateTile('layer-color', 1, 0, 'color-32bit', 0);
    colorTile.data![0] = 220;
    colorTile.data![1] = 40;
    colorTile.data![2] = 90;
    colorTile.data![3] = 255;
    colorTile.data![BYTES_32BIT - 4] = 12;
    colorTile.data![BYTES_32BIT - 3] = 34;
    colorTile.data![BYTES_32BIT - 2] = 56;
    colorTile.data![BYTES_32BIT - 1] = 180;
    colorTile.version = 12;
    grid.setLayerFormat('layer-color', 'color-32bit');

    const vectorStroke: VectorStroke = {
      id: 'vs-1',
      layerId: 'layer-vector',
      tool: 'brush',
      knots: [
        { x: 10, y: 20, pressure: 0.7, width: 5, timestamp: 1000 },
        { x: 120, y: 180, pressure: 0.9, width: 8, timestamp: 1016 },
      ],
      color: '#112233',
      baseWidth: 6,
      opacity: 0.95,
      bounds: { minX: 10, minY: 20, maxX: 120, maxY: 180 },
    };

    const textData: TextLayerData = {
      x: 300,
      y: 220,
      text: 'SORA V2!\nLINE TWO',
      fontFamily: 'Anime Ace',
      fontSize: 36,
      lineSpacing: 1.4,
      bold: true,
      italic: false,
      align: 'center',
      color: '#000000',
      outline: true,
      outlineColor: '#ffffff',
      outlineWidth: 3,
      writingMode: 'vertical-rl',
    };

    const balloon = createDefaultSpeechBalloon(500, 400, 260, 180, 'jagged-flash');
    balloon.text = 'BOOM!';
    balloon.vertical = true;
    balloon.tail.tip = { x: 460, y: 650, pressure: 1, width: 4 };

    const frame = createRectFrame('frame-folder-1', 80, 80, 1600, 2200, {
      dpi: 600,
      borderWidth: 8,
      gutterVerticalPx: 70,
      gutterHorizontalPx: 110,
    });

    const maskCanvas = createMockMaskCanvas(16, 8, (x, y) => (x + y * 16) % 256);

    const perspectiveRuler: PerspectiveRuler = {
      id: 'persp-1',
      type: '2-point',
      enabled: true,
      locked: false,
      snapEnabled: true,
      horizonAngle: 0,
      guideRayCount: 8,
      vps: [
        { id: 'vp1', x: 200, y: 900, label: 'VP1', color: '#8b5cf6' },
        { id: 'vp2', x: 1800, y: 900, label: 'VP2', color: '#06b6d4' },
      ],
      grid: {
        enabled: true,
        density: 16,
        plane: 'ground',
        opacity: 0.3,
      },
    };

    const animationTimeline: AnimationTimeline = {
      fps: 24,
      totalFrames: 48,
      currentFrame: 5,
      cels: {
        1: 'layer-mono',
        5: 'layer-color',
      },
      onionSkin: {
        enabled: true,
        prevFrames: 2,
        nextFrames: 2,
        prevTint: '#3b82f6',
        nextTint: '#10b981',
        opacity: 0.45,
      },
    };

    const layers: LayerItem[] = [
      {
        id: 'layer-adj',
        name: 'Curves Adj',
        type: 'adjustment',
        visible: true,
        opacity: 0.8,
        blendMode: 'normal',
        locked: false,
        parentId: null,
        adjustmentData: {
          type: 'levels',
          blackPoint: 12,
          gamma: 1.15,
          whitePoint: 244,
        },
      },
      {
        id: 'layer-text',
        name: 'SORA V2!',
        type: 'text',
        visible: true,
        opacity: 1,
        blendMode: 'normal',
        locked: false,
        parentId: null,
        textData,
      },
      {
        id: 'layer-balloon',
        name: 'Balloon',
        type: 'balloon',
        visible: true,
        opacity: 0.9,
        blendMode: 'normal',
        locked: false,
        parentId: 'frame-folder-1',
        balloonData: balloon,
      },
      {
        id: 'frame-folder-1',
        name: 'Panel 1',
        type: 'frame-folder',
        visible: true,
        opacity: 1,
        blendMode: 'normal',
        locked: false,
        parentId: null,
        comicFrames: [frame],
      },
      {
        id: 'layer-vector',
        name: 'Vectors',
        type: 'vector',
        visible: true,
        opacity: 1,
        blendMode: 'normal',
        locked: false,
        parentId: 'frame-folder-1',
        vectorStrokes: [vectorStroke],
      },
      {
        id: 'layer-mono',
        name: 'Inks 1-bit',
        type: 'raster',
        visible: true,
        opacity: 1,
        blendMode: 'linear-burn',
        locked: false,
        parentId: 'frame-folder-1',
        expressionColor: 'monochrome',
        monoThreshold: 140,
        monoExpressBlack: true,
        monoExpressWhite: false,
        layerColorEnabled: true,
        layerColor: '#1c73c2',
        layerSubColor: '#ffffff',
        maskCanvas,
        maskEnabled: true,
        maskLinked: true,
      },
      {
        id: 'layer-gray',
        name: 'Screentone 8-bit',
        type: 'raster',
        visible: true,
        opacity: 0.85,
        blendMode: 'multiply',
        locked: false,
        parentId: 'frame-folder-1',
        expressionColor: 'gray',
        toneEnabled: true,
        toneFrequency: 65,
        toneAngle: 45,
        toneDotShape: 'euclidean',
        toneDensity: 40,
        toneDensityType: 'image',
      },
      {
        id: 'layer-color',
        name: 'Glow FX 32-bit',
        type: 'raster',
        visible: true,
        opacity: 0.9,
        blendMode: 'add-glow',
        locked: false,
        parentId: null,
        styles: {
          stroke: { enabled: true, size: 4, color: '#ff0044', position: 'outside', opacity: 1 },
          dropShadow: { enabled: true, color: '#000000', opacity: 0.6, angle: 120, distance: 12, blur: 16, spread: 10 },
          outerGlow: { enabled: true, color: '#00ffff', opacity: 0.75, blur: 20, spread: 5 },
        },
      },
    ];

    const progressLog: SaveProgress[] = [];
    const serialized = await serializeSoraV2(
      {
        name: 'Manga Page 01',
        dimensions: { width: 7016, height: 9921, dpi: 600 },
        colorMode: 'color',
        layers,
        layerCanvasesMap: new Map(),
        tileGrid: grid,
        getEffectiveOpacity: (l) => l.opacity,
        isLayerEffectivelyVisible: (l) => l.visible,
        perspectiveRuler,
        animationTimeline,
        timelapse: { enabled: true, frameCount: 312, fps: 30, resolution: '1080p', aspectRatio: 'original' },
        onProgress: (p) => progressLog.push(p),
      },
      grid
    );

    // Must be compact ZIP binary starting with PK\x03\x04
    expect(isSoraV2Bytes(serialized.bytes)).toBe(true);
    expect(serialized.bytes[0]).toBe(0x50);
    expect(serialized.bytes[1]).toBe(0x4b);

    // Inspect ZIP structure directly: manifest + native tile files + mask file
    const entries = unzipSync(serialized.bytes);
    expect(entries['manifest.json']).toBeDefined();
    expect(entries['tiles/layer-mono/2_3.bin']).toBeDefined();
    expect(entries['tiles/layer-gray/0_1.bin']).toBeDefined();
    expect(entries['tiles/layer-color/1_0.bin']).toBeDefined();
    expect(entries['masks/layer-mono.bin']).toBeDefined();

    // Progress indicator reached 100%
    expect(progressLog.length).toBeGreaterThanOrEqual(3);
    expect(progressLog[progressLog.length - 1].phase).toBe('done');
    expect(progressLog[progressLog.length - 1].percent).toBe(100);

    // Round-trip parse with auto-detection
    const parsed = await parseSoraProject(serialized.bytes);
    expect(parsed.format).toBe('v2');
    expect(parsed.version).toBe('2.0');
    expect(parsed.name).toBe('Manga Page 01');
    expect(parsed.dimensions).toEqual({ width: 7016, height: 9921, dpi: 600 });
    expect(parsed.layers).toHaveLength(8);
    expect(parsed.tileGrid).toBeDefined();

    // Verify 1-bit tile exact binary round-trip
    const restoredMono = parsed.tileGrid!.getTile('layer-mono', 2, 3, 0);
    expect(restoredMono).toBeDefined();
    expect(restoredMono!.format).toBe('monochrome-1bit');
    expect(restoredMono!.data!.byteLength).toBe(BYTES_1BIT);
    expect(getPixel1Bit(restoredMono!.data!, 5, 7)).toBe(1);
    expect(getPixel1Bit(restoredMono!.data!, 200, 123)).toBe(1);
    expect(getPixel1Bit(restoredMono!.data!, 0, 0)).toBe(0);
    expect(restoredMono!.version).toBe(9);

    // Verify 8-bit tile exact binary round-trip
    const restoredGray = parsed.tileGrid!.getTile('layer-gray', 0, 1, 0);
    expect(restoredGray).toBeDefined();
    expect(restoredGray!.format).toBe('grayscale-8bit');
    expect(restoredGray!.data!.byteLength).toBe(BYTES_8BIT);
    expect(restoredGray!.data![0]).toBe(42);
    expect(restoredGray!.data![256 * 10 + 15]).toBe(199);
    expect(restoredGray!.data![BYTES_8BIT - 1]).toBe(255);
    expect(restoredGray!.version).toBe(4);

    // Verify 32-bit tile exact binary round-trip
    const restoredColor = parsed.tileGrid!.getTile('layer-color', 1, 0, 0);
    expect(restoredColor).toBeDefined();
    expect(restoredColor!.format).toBe('color-32bit');
    expect(restoredColor!.data!.byteLength).toBe(BYTES_32BIT);
    expect(Array.from(restoredColor!.data!.subarray(0, 4))).toEqual([220, 40, 90, 255]);
    expect(Array.from(restoredColor!.data!.subarray(BYTES_32BIT - 4))).toEqual([12, 34, 56, 180]);
    expect(restoredColor!.version).toBe(12);

    // Verify binary mask round-trip
    const restoredMask = parsed.masksBinary?.get('layer-mono');
    expect(restoredMask).toBeDefined();
    expect(restoredMask!.width).toBe(16);
    expect(restoredMask!.height).toBe(8);
    expect(restoredMask!.data[0]).toBe(0);
    expect(restoredMask!.data[17]).toBe(17);
    expect(restoredMask!.data[127]).toBe(127);

    // Verify non-destructive vector, text, balloon, frame, styles, screentone, perspective, animation, timelapse
    expect(parsed.layers.find((l) => l.id === 'layer-vector')?.vectorStrokes).toEqual([vectorStroke]);
    expect(parsed.layers.find((l) => l.id === 'layer-text')?.textData).toEqual(textData);
    expect(parsed.layers.find((l) => l.id === 'layer-balloon')?.balloonData?.text).toBe('BOOM!');
    expect(parsed.layers.find((l) => l.id === 'frame-folder-1')?.comicFrames?.[0].polygon).toEqual(frame.polygon);
    expect(parsed.layers.find((l) => l.id === 'layer-color')?.styles?.dropShadow?.distance).toBe(12);
    expect(parsed.layers.find((l) => l.id === 'layer-gray')?.toneFrequency).toBe(65);
    expect(parsed.perspectiveRuler).toEqual(perspectiveRuler);
    expect(parsed.animationTimeline).toEqual(animationTimeline);
    expect(parsed.timelapse).toEqual({
      enabled: true,
      frameCount: 312,
      fps: 30,
      resolution: '1080p',
      aspectRatio: 'original',
    });
  });

  it('hydrates paged-out scratch disk tiles cleanly during .sora v2 save without data loss', async () => {
    const driver = new InMemoryScratchDiskDriver();
    const grid = new SparseTileGrid({
      sessionId: 'paged-save-test',
      budgetMb: 1,
      driver,
    });

    const tile = grid.getOrCreateTile('layer-1', 0, 0, 'grayscale-8bit', 0);
    tile.data![100] = 177;
    tile.data![5000] = 88;
    const rawCopy = new Uint8Array(tile.data!);

    // Simulate SSD scratch eviction: write tile to scratch driver and drop RAM pointer
    await driver.writeTiles('paged-save-test', [
      { layerId: 'layer-1', tileX: 0, tileY: 0, data: rawCopy },
    ]);
    tile.data = null;
    tile.isPagedToDisk = true;

    const layers: LayerItem[] = [
      {
        id: 'layer-1',
        name: 'Paged Layer',
        type: 'raster',
        visible: true,
        opacity: 1,
        blendMode: 'normal',
        locked: false,
        parentId: null,
        expressionColor: 'gray',
      },
    ];

    const saved = await serializeSoraV2(
      {
        name: 'Paged Doc',
        dimensions: { width: 512, height: 512, dpi: 300 },
        colorMode: 'grayscale',
        layers,
        layerCanvasesMap: new Map(),
        tileGrid: grid,
        getEffectiveOpacity: (l) => l.opacity,
        isLayerEffectivelyVisible: (l) => l.visible,
      },
      grid
    );

    const parsed = await parseSoraProject(saved.bytes);
    const restored = parsed.tileGrid!.getTile('layer-1', 0, 0, 0);
    expect(restored?.data?.[100]).toBe(177);
    expect(restored?.data?.[5000]).toBe(88);
  });

  it('auto-detects legacy v1.2 JSON (string & UTF-8 bytes with BOM) and preserves backward compatibility', async () => {
    const layers: LayerItem[] = [
      {
        id: 'layer-bg',
        name: 'Background',
        type: 'raster',
        visible: true,
        opacity: 1,
        blendMode: 'normal',
        locked: false,
        parentId: null,
      },
    ];

    const v1Payload = buildSoraProjectPayload({
      name: 'Legacy Project',
      dimensions: { width: 1440, height: 900, dpi: 300 },
      colorMode: 'color',
      layers,
      layerCanvasesMap: new Map(),
      getEffectiveOpacity: (l) => l.opacity,
      isLayerEffectivelyVisible: (l) => l.visible,
    });
    const jsonString = JSON.stringify(v1Payload);

    // String input
    const parsedStr = await parseSoraProject(jsonString);
    expect(parsedStr.format).toBe('v1');
    expect(parsedStr.version).toBe('1.2');
    expect(parsedStr.name).toBe('Legacy Project');
    expect(parsedStr.layers).toHaveLength(1);

    // UTF-8 ArrayBuffer with BOM
    const utf8WithBom = new Uint8Array([0xef, 0xbb, 0xbf, ...new TextEncoder().encode(jsonString)]);
    expect(isSoraV2Bytes(utf8WithBom)).toBe(false);
    const parsedBytes = await parseSoraProject(utf8WithBom.buffer);
    expect(parsedBytes.format).toBe('v1');
    expect(parsedBytes.name).toBe('Legacy Project');
  });

  it('extracts preview.png via extractSoraPreview without decompressing tiles, and supports SORA magic wrapper', async () => {
    const fakePng = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
    const manifest = {
      format: 'sora-v2',
      app: 'Ink Studio',
      version: '2.0',
      tileSize: 256,
      name: 'Preview Test',
      dimensions: { width: 512, height: 512, dpi: 300 },
      colorMode: 'color',
      layers: [],
      layerFormats: {},
      layerTileKeys: {},
      masksMeta: {},
      preview: { path: 'preview.png', width: 256, height: 256 },
      savedAt: Date.now(),
    };

    const zipBytes = zipSync({
      'manifest.json': new TextEncoder().encode(JSON.stringify(manifest)),
      'preview.png': fakePng,
    });

    // Direct ZIP
    expect(Array.from(extractSoraPreview(zipBytes)!)).toEqual(Array.from(fakePng));

    // With optional 8-byte SORA\x00\x02 header prefix
    const wrapped = new Uint8Array(8 + zipBytes.byteLength);
    wrapped.set([0x53, 0x4f, 0x52, 0x41, 0x00, 0x02, 0x00, 0x00], 0);
    wrapped.set(zipBytes, 8);
    expect(isSoraV2Bytes(wrapped)).toBe(true);
    expect(Array.from(extractSoraPreview(wrapped)!)).toEqual(Array.from(fakePng));

    const parsed = await parseSoraProject(wrapped);
    expect(parsed.format).toBe('v2');
    expect(parsed.previewDataUrl).toMatch(/^data:image\/png;base64,/);
  });

  it('sanitizes unsafe layer IDs and rejects path traversal and corrupted tile payloads', async () => {
    const grid = new SparseTileGrid();
    const weirdId = '../bad/layer:name\\0';
    const tile = grid.getOrCreateTile(weirdId, 0, 0, 'monochrome-1bit', 0);
    setPixel1Bit(tile.data!, 3, 4, 1);

    const saved = await serializeSoraV2(
      {
        name: 'Safe Keys',
        dimensions: { width: 256, height: 256, dpi: 300 },
        colorMode: 'monochrome',
        layers: [
          {
            id: weirdId,
            name: 'Weird',
            type: 'raster',
            visible: true,
            opacity: 1,
            blendMode: 'normal',
            locked: false,
            parentId: null,
          },
        ],
        layerCanvasesMap: new Map(),
        tileGrid: grid,
        getEffectiveOpacity: () => 1,
        isLayerEffectivelyVisible: () => true,
      },
      grid
    );

    const parsed = await parseSoraProject(saved.bytes);
    const restored = parsed.tileGrid!.getTile(weirdId, 0, 0, 0);
    expect(restored).toBeDefined();
    expect(getPixel1Bit(restored!.data!, 3, 4)).toBe(1);

    // Path traversal archive rejected
    const evilZip = zipSync({
      'manifest.json': new TextEncoder().encode(
        JSON.stringify({ dimensions: { width: 256, height: 256 }, layers: [] })
      ),
      '../escape.bin': new Uint8Array([1, 2, 3]),
    });
    await expect(parseSoraProject(evilZip)).rejects.toThrow(/Unsafe archive path/);

    // Truncated / mismatched tile payload rejected
    const corruptZip = zipSync({
      'manifest.json': new TextEncoder().encode(
        JSON.stringify({
          dimensions: { width: 256, height: 256 },
          layers: [{ id: 'l1', name: 'L1', type: 'raster', visible: true, opacity: 1, blendMode: 'normal', locked: false, parentId: null }],
          layerTileKeys: { l1: 'l1' },
        })
      ),
      'tiles/l1/0_0.bin': new Uint8Array([0, 1, 0, 0, 0, 0, 32, 0, 0, 0xff]), // claims 8192 bytes, only 1 byte present
    });
    await expect(parseSoraProject(corruptZip)).rejects.toThrow(/length mismatch/);
  });

  it('serializeDocument writes binary .sora v2 Blob instead of legacy JSON', async () => {
    const grid = new SparseTileGrid();
    const t = grid.getOrCreateTile('l1', 0, 0, 'monochrome-1bit', 0);
    setPixel1Bit(t.data!, 10, 10, 1);

    const res = await serializeDocument(
      {
        name: 'Doc',
        dimensions: { width: 512, height: 512, dpi: 600 },
        colorMode: 'monochrome',
        layers: [
          {
            id: 'l1',
            name: 'Ink',
            type: 'raster',
            visible: true,
            opacity: 1,
            blendMode: 'normal',
            locked: false,
            parentId: null,
          },
        ],
        layerCanvasesMap: new Map(),
        tileGrid: grid,
        getEffectiveOpacity: () => 1,
        isLayerEffectivelyVisible: () => true,
      },
      '.sora'
    );

    expect(res.data).toBeInstanceOf(Blob);
    const buf = await (res.data as Blob).arrayBuffer();
    expect(isSoraV2Bytes(buf)).toBe(true);
    const parsed = await parseSoraProject(buf);
    expect(parsed.format).toBe('v2');
    expect(getPixel1Bit(parsed.tileGrid!.getTile('l1', 0, 0, 0)!.data!, 10, 10)).toBe(1);
  });
});

describe('Pixel-Accurate GPU Tiled Export & CPU Fallback', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('computes exact tile geometry and Layer Style halo margins for large documents', () => {
    const layers: LayerItem[] = [
      {
        id: 'l1',
        name: 'Styled',
        type: 'raster',
        visible: true,
        opacity: 1,
        blendMode: 'add-glow',
        locked: false,
        parentId: null,
        styles: {
          stroke: { enabled: true, size: 10, color: '#000000', position: 'outside', opacity: 1 },
          dropShadow: { enabled: true, color: '#000000', opacity: 0.5, angle: 90, distance: 20, blur: 16, spread: 0 },
        },
      },
      {
        id: 'l2',
        name: 'Hidden Huge Glow',
        type: 'raster',
        visible: false,
        opacity: 1,
        blendMode: 'normal',
        locked: false,
        parentId: null,
        styles: {
          outerGlow: { enabled: true, color: '#ffffff', opacity: 1, blur: 100, spread: 0 },
        },
      },
    ];

    const margin = computeMaxLayerStyleMargin(layers);
    // dropShadow extent = ceil(20 + 16 * 1.5) + 2 = 46; hidden layer ignored
    expect(margin).toBe(46);

    const plan = buildGpuExportTilePlan(4500, 3000, 2048, margin);
    // innerStep = 2048 - 92 = 1956 -> ceil(4500/1956) = 3 cols, ceil(3000/1956) = 2 rows = 6 tiles
    expect(plan.tiles).toHaveLength(6);
    expect(plan.fboWidth).toBeLessThanOrEqual(2048);
    expect(plan.fboHeight).toBeLessThanOrEqual(2048);

    // Top-left tile has 0 left/top pad, positive right/bottom halo pad
    expect(plan.tiles[0].padLeft).toBe(0);
    expect(plan.tiles[0].padTop).toBe(0);
    expect(plan.tiles[0].padRight).toBe(margin);
    expect(plan.tiles[0].padBottom).toBe(margin);

    // Interior/second column tile has left halo pad for seamless shadow/stroke stitching
    expect(plan.tiles[1].padLeft).toBe(margin);
    expect(plan.tiles[1].originX).toBe(plan.tiles[1].tileX - margin);

    // Exact full-canvas coverage with zero gaps or overlaps
    const totalArea = plan.tiles.reduce((acc, t) => acc + t.width * t.height, 0);
    expect(totalArea).toBe(4500 * 3000);
  });

  it('uses ViewportCompositor tiled GPU rendering when WebGL2 is available, passing exact 1:1 pan/zoom/transparentBackground', async () => {
    const drawImageCalls: Array<{
      sx: number;
      sy: number;
      sw: number;
      sh: number;
      dx: number;
      dy: number;
      dw: number;
      dh: number;
    }> = [];

    const mock2dCtx = {
      drawImage: (
        _src: unknown,
        sx: number,
        sy: number,
        sw: number,
        sh: number,
        dx: number,
        dy: number,
        dw: number,
        dh: number
      ) => {
        drawImageCalls.push({ sx, sy, sw, sh, dx, dy, dw, dh });
      },
      fillRect: vi.fn(),
      clearRect: vi.fn(),
      save: vi.fn(),
      restore: vi.fn(),
    };

    vi.stubGlobal('document', {
      createElement: (tag: string) => {
        if (tag !== 'canvas') return {};
        return {
          width: 0,
          height: 0,
          getContext: (type: string) => (type === '2d' ? mock2dCtx : null),
          toBlob: (cb: (b: Blob | null) => void, mime?: string) => {
            cb(new Blob([new Uint8Array([1, 2, 3, 4])], { type: mime || 'image/png' }));
          },
        };
      },
    });

    vi.spyOn(ViewportCompositor.prototype, 'isReady').mockReturnValue(true);
    vi.spyOn(ViewportCompositor.prototype, 'getMaxTextureSize').mockReturnValue(2048);
    const renderSpy = vi.spyOn(ViewportCompositor.prototype, 'render').mockImplementation(() => {});
    const disposeSpy = vi.spyOn(ViewportCompositor.prototype, 'dispose').mockImplementation(() => {});

    const grid = new SparseTileGrid();
    grid.getOrCreateTile('glow-layer', 0, 0, 'color-32bit', 0);

    const layers: LayerItem[] = [
      {
        id: 'glow-layer',
        name: 'Glow + Tone + Tint',
        type: 'raster',
        visible: true,
        opacity: 1,
        blendMode: 'color-dodge-glow',
        locked: false,
        parentId: null,
        toneEnabled: true,
        layerColorEnabled: true,
        layerColor: '#ff3366',
        styles: {
          outerGlow: { enabled: true, color: '#00ffee', opacity: 0.8, blur: 10, spread: 0 },
        },
      },
    ];

    // 1. Sync compositeCanvas (transparent PNG) on a 3000x1500 doc -> splits horizontally into 2 tiles
    const outCanvas = compositeCanvas(
      { width: 3000, height: 1500, dpi: 600 },
      layers,
      new Map(),
      (l) => l.opacity,
      (l) => l.visible,
      false,
      grid
    );
    expect(outCanvas.width).toBe(3000);
    expect(outCanvas.height).toBe(1500);
    expect(renderSpy).toHaveBeenCalledTimes(2);
    expect(drawImageCalls).toHaveLength(2);
    expect(disposeSpy).toHaveBeenCalledTimes(1);

    // Verify 1:1 zoom, dpr=1, bypassStackCache, transparentBackground=true
    const firstCallArgs = renderSpy.mock.calls[0];
    expect(firstCallArgs[1].zoom).toBe(1);
    expect(firstCallArgs[1].rotation).toBe(0);
    expect(firstCallArgs[4]?.transparentBackground).toBe(true);
    expect(firstCallArgs[4]?.bypassStackCache).toBe(true);
    expect(firstCallArgs[4]?.devicePixelRatio).toBe(1);

    // Verify stitched regions cover exact [0..3000] x [0..1500]
    expect(drawImageCalls[0].dx).toBe(0);
    expect(drawImageCalls[0].dw + drawImageCalls[1].dw).toBe(3000);
    expect(drawImageCalls[1].dx).toBe(drawImageCalls[0].dw);

    // 2. Async exportImage for JPEG -> transparentBackground=false (white background)
    renderSpy.mockClear();
    const exported = await exportImage(
      {
        name: 'Artwork',
        dimensions: { width: 1024, height: 1024, dpi: 300 },
        colorMode: 'color',
        layers,
        layerCanvasesMap: new Map(),
        tileGrid: grid,
        getEffectiveOpacity: (l) => l.opacity,
        isLayerEffectivelyVisible: (l) => l.visible,
      },
      { format: 'jpg', quality: 0.9 }
    );

    expect(exported.usedGpu).toBe(true);
    expect(exported.mimeType).toBe('image/jpeg');
    expect(renderSpy).toHaveBeenCalledTimes(1);
    expect(renderSpy.mock.calls[0][4]?.transparentBackground).toBe(false);

    // 3. Reusable region renderer for tall Webtoon slices
    renderSpy.mockClear();
    const renderer = createDocumentRegionRenderer(
      { width: 800, height: 5000, dpi: 300 },
      layers,
      new Map(),
      (l) => l.opacity,
      (l) => l.visible,
      grid
    );
    expect(renderer.usedGpu).toBe(true);
    const sliceTarget = document.createElement('canvas');
    sliceTarget.width = 800;
    sliceTarget.height = 1280;
    renderer.renderRegion(0, 1280, 800, 1280, sliceTarget, true);
    expect(renderSpy).toHaveBeenCalledTimes(1);
    expect(renderSpy.mock.calls[0][4]?.transparentBackground).toBe(false);
    renderer.dispose();
  });

  it('falls back cleanly to CPU compositor when WebGL2 is unavailable', async () => {
    const fillRectSpy = vi.fn();
    const mock2dCtx = {
      fillStyle: '',
      globalAlpha: 1,
      globalCompositeOperation: 'source-over',
      fillRect: fillRectSpy,
      clearRect: vi.fn(),
      drawImage: vi.fn(),
      save: vi.fn(),
      restore: vi.fn(),
    };

    vi.stubGlobal('document', {
      createElement: () => ({
        width: 0,
        height: 0,
        getContext: (type: string) => (type === '2d' ? mock2dCtx : null),
      }),
    });

    vi.spyOn(ViewportCompositor.prototype, 'isReady').mockReturnValue(false);

    const res = await compositeCanvasAsync(
      { width: 512, height: 512, dpi: 300 },
      [],
      new Map(),
      (l) => l.opacity,
      (l) => l.visible,
      true
    );

    expect(res.usedGpu).toBe(false);
    expect(res.canvas.width).toBe(512);
    expect(res.canvas.height).toBe(512);
    expect(fillRectSpy).toHaveBeenCalledWith(0, 0, 512, 512);
  });
});
