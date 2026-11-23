import { describe, it, expect, beforeEach, vi } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  AppSettings,
  DEFAULT_APP_SETTINGS,
  loadAppSettings,
  saveAppSettings,
} from '../../types/settings';
import { PerformanceSettingsTab } from '../../components/PerformanceSettingsTab';
import {
  GPU_TEXTURE_POOL_CONFIGS,
  buildPerformancePreset,
  computeAdobeMemoryLimits,
  computeRecommendedSettings,
  memoryMbToPercent,
  memoryPercentToMb,
  performanceManager,
  resolveEffectiveDpr,
} from '../performanceManager';
import { ViewportCompositor } from '../compositor';
import { SparseTileGrid, TILE_SIZE, createTileBuffer } from '../tileEngine';
import { DocumentStore } from '../documentStore';
import { canUseWebGlForBrush } from '../../engine/BrushEngine';

describe('Performance & Optimization System', () => {
  beforeEach(() => {
    const storage: Record<string, string> = {};
    (globalThis as any).localStorage = {
      getItem: (k: string) => storage[k] || null,
      setItem: (k: string, v: string) => {
        storage[k] = String(v);
      },
      removeItem: (k: string) => {
        delete storage[k];
      },
      clear: () => {
        Object.keys(storage).forEach((k) => delete storage[k]);
      },
    };
    performanceManager.applySettings(DEFAULT_APP_SETTINGS);
  });

  it('sanitizes and persists all new performance settings cleanly across legacy & corrupt storage', () => {
    const defaults = loadAppSettings();
    expect(defaults.renderBackend).toBe('auto');
    expect(defaults.gpuPowerPreference).toBe('high-performance');
    expect(defaults.desktopGraphicsApi).toBe('auto');
    expect(defaults.gpuBrushAcceleration).toBe(true);
    expect(defaults.gpuTexturePoolPreset).toBe('high');
    expect(defaults.layerStackCaching).toBe(true);
    expect(defaults.viewportResolutionScale).toBe('capped-2x');
    expect(defaults.canvasFilteringQuality).toBe('auto');
    expect(defaults.memoryAllocationPercent).toBe(60);
    expect(defaults.undoRamSteps).toBe(15);
    expect(defaults.offloadInactiveTabs).toBe(true);
    expect(defaults.scratchDiskCompression).toBe('lz4');
    expect(defaults.cpuWorkerThreads).toBe(0);
    expect(defaults.useNativeRustAcceleration).toBe(true);
    expect(defaults.preview3DMaxResolution).toBe(1920);
    expect(defaults.preview3DAntialias).toBe(true);

    // Corrupt values fall back safely
    localStorage.setItem(
      'ink_studio_app_settings',
      JSON.stringify({
        renderBackend: 'invalid-backend',
        gpuPowerPreference: 'turbo',
        desktopGraphicsApi: 'metal99',
        gpuTexturePoolPreset: 'massive',
        viewportResolutionScale: '8x',
        canvasFilteringQuality: 'blurry',
        scratchDiskCompression: 'bzip',
        tileMemoryBudgetMb: 999999,
        memoryAllocationPercent: 5,
        maxHistorySteps: 5000,
        undoRamSteps: 1,
        cpuWorkerThreads: -3,
        preview3DMaxResolution: 9999,
      })
    );
    const sanitized = loadAppSettings();
    expect(sanitized.renderBackend).toBe('auto');
    expect(sanitized.gpuPowerPreference).toBe('high-performance');
    expect(sanitized.desktopGraphicsApi).toBe('auto');
    expect(sanitized.gpuTexturePoolPreset).toBe('high');
    expect(sanitized.viewportResolutionScale).toBe('capped-2x');
    expect(sanitized.canvasFilteringQuality).toBe('auto');
    expect(sanitized.scratchDiskCompression).toBe('lz4');
    expect(sanitized.tileMemoryBudgetMb).toBe(1024);
    expect(sanitized.memoryAllocationPercent).toBe(20);
    expect(sanitized.maxHistorySteps).toBe(200);
    expect(sanitized.undoRamSteps).toBe(4);
    expect(sanitized.cpuWorkerThreads).toBe(0);
    expect(sanitized.preview3DMaxResolution).toBe(1920);

    // Valid high-RAM workstation settings round-trip cleanly
    saveAppSettings({
      ...DEFAULT_APP_SETTINGS,
      tileMemoryBudgetMb: 16384,
      memoryAllocationPercent: 65,
      maxHistorySteps: 150,
      undoRamSteps: 30,
      renderBackend: 'canvas2d',
      gpuPowerPreference: 'low-power',
      desktopGraphicsApi: 'vulkan',
      gpuTexturePoolPreset: 'ultra',
      viewportResolutionScale: '1x',
      canvasFilteringQuality: 'pixelated',
      scratchDiskCompression: 'none',
      cpuWorkerThreads: 8,
      preview3DMaxResolution: 2560,
      preview3DAntialias: false,
    });

    const loaded = loadAppSettings();
    expect(loaded.tileMemoryBudgetMb).toBe(16384);
    expect(loaded.memoryAllocationPercent).toBe(65);
    expect(loaded.maxHistorySteps).toBe(150);
    expect(loaded.undoRamSteps).toBe(30);
    expect(loaded.renderBackend).toBe('canvas2d');
    expect(loaded.gpuPowerPreference).toBe('low-power');
    expect(loaded.desktopGraphicsApi).toBe('vulkan');
    expect(loaded.gpuTexturePoolPreset).toBe('ultra');
    expect(loaded.viewportResolutionScale).toBe('1x');
    expect(loaded.canvasFilteringQuality).toBe('pixelated');
    expect(loaded.scratchDiskCompression).toBe('none');
    expect(loaded.cpuWorkerThreads).toBe(8);
    expect(loaded.preview3DMaxResolution).toBe(2560);
    expect(loaded.preview3DAntialias).toBe(false);
  });

  it('computes Adobe-style memory limits and converts cleanly between % and MB', () => {
    const limits16g = computeAdobeMemoryLimits(16384);
    expect(limits16g.minMb).toBe(256);
    expect(limits16g.idealMinMb).toBe(8192); // 50% of 16GB
    expect(limits16g.idealMaxMb).toBe(11392); // floor(16384 * 0.7 / 128) * 128
    expect(limits16g.maxMb).toBe(13824); // floor(16384 * 0.85 / 128) * 128

    const mbAt60 = memoryPercentToMb(60, 16384);
    expect(mbAt60 % 128).toBe(0);
    expect(memoryMbToPercent(mbAt60, 16384)).toBe(60);

    // 64GB workstation clamps safely at 32GB ceiling
    const limits64g = computeAdobeMemoryLimits(65536);
    expect(limits64g.maxMb).toBe(32768);
  });

  it('resolves viewport HiDPI resolution scaling modes accurately', () => {
    expect(resolveEffectiveDpr(2.5, 'native')).toBe(2.5);
    expect(resolveEffectiveDpr(2.5, 'capped-2x')).toBe(2);
    expect(resolveEffectiveDpr(1.5, 'capped-2x')).toBe(1.5);
    expect(resolveEffectiveDpr(2.0, '1x')).toBe(1);
    expect(resolveEffectiveDpr(2.0, '0.75x')).toBe(0.75);
  });

  it('generates calibrated optimization presets for battery, balanced, maximum, and compatibility', () => {
    const battery = buildPerformancePreset('battery', 16384);
    expect(battery.gpuPowerPreference).toBe('low-power');
    expect(battery.gpuTexturePoolPreset).toBe('low');
    expect(battery.viewportResolutionScale).toBe('1x');
    expect(battery.memoryAllocationPercent).toBe(40);

    const max = buildPerformancePreset('maximum', 32768);
    expect(max.renderBackend).toBe('webgl2');
    expect(max.gpuPowerPreference).toBe('high-performance');
    expect(max.gpuTexturePoolPreset).toBe('ultra');
    expect(max.viewportResolutionScale).toBe('native');

    const compat = buildPerformancePreset('compatibility', 8192);
    expect(compat.renderBackend).toBe('canvas2d');
    expect(compat.gpuBrushAcceleration).toBe(false);
    expect(compat.layerStackCaching).toBe(false);
  });

  it('disables GPU brush dispatch when renderBackend is canvas2d or gpuBrushAcceleration is false', () => {
    performanceManager.applySettings({
      ...DEFAULT_APP_SETTINGS,
      renderBackend: 'canvas2d',
      gpuBrushAcceleration: true,
    });
    expect(canUseWebGlForBrush()).toBe(false);

    performanceManager.applySettings({
      ...DEFAULT_APP_SETTINGS,
      renderBackend: 'auto',
      gpuBrushAcceleration: false,
    });
    expect(canUseWebGlForBrush()).toBe(false);
  });

  it('ViewportCompositor skips WebGL2 init when renderBackend is canvas2d and reuses 2D ImageData with frustum culling', () => {
    let webglRequested = false;
    let createImageDataCalls = 0;
    const drawImagePositions: Array<{ x: number; y: number }> = [];

    const mock2DCtx = {
      save: vi.fn(),
      restore: vi.fn(),
      clearRect: vi.fn(),
      scale: vi.fn(),
      translate: vi.fn(),
      rotate: vi.fn(),
      fillRect: vi.fn(),
      drawImage: vi.fn((_img: unknown, x: number, y: number) => {
        drawImagePositions.push({ x, y });
      }),
      putImageData: vi.fn(),
      createImageData: vi.fn((w: number, h: number) => {
        createImageDataCalls++;
        return { width: w, height: h, data: new Uint8ClampedArray(w * h * 4) };
      }),
      imageSmoothingEnabled: true,
      fillStyle: '',
      globalAlpha: 1,
      globalCompositeOperation: 'source-over',
    };

    const mockCanvas = {
      width: 512,
      height: 512,
      getContext: (kind: string) => {
        if (kind === 'webgl2') {
          webglRequested = true;
          return null;
        }
        return mock2DCtx;
      },
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    } as unknown as HTMLCanvasElement;

    const origDocument = (globalThis as any).document;
    (globalThis as any).document = {
      createElement: () => ({
        width: TILE_SIZE,
        height: TILE_SIZE,
        getContext: () => mock2DCtx,
      }),
    };

    try {
      const compositor = new ViewportCompositor(mockCanvas, {
        renderBackend: 'canvas2d',
        gpuTexturePoolPreset: 'low',
        filteringQuality: 'pixelated',
      });

      expect(webglRequested).toBe(false);
      expect(compositor.getBackend()).toBe('canvas2d');
      expect(compositor.getTelemetry().backend).toBe('canvas2d');
      expect(compositor.getTelemetry().estimatedVramMb).toBe(0);

      // Populate 4 tiles: (0,0) and (1,0) visible, (10,10) and (11,11) far off-screen
      const grid = new SparseTileGrid();
      const layerId = 'layer-1';
      grid.setLayerFormat(layerId, 'color-32bit');
      for (const [tx, ty] of [
        [0, 0],
        [1, 0],
        [10, 10],
        [11, 11],
      ]) {
        const tile = createTileBuffer(layerId, tx, ty, 'color-32bit', 0);
        tile.data!.fill(255);
        grid.setTile(layerId, tx, ty, tile);
      }

      const layers = [
        {
          id: layerId,
          name: 'Layer 1',
          type: 'raster' as const,
          visible: true,
          opacity: 1,
          blendMode: 'normal' as const,
          locked: false,
          parentId: null,
        },
      ];

      // Render two consecutive frames focused on top-left corner (0..512, 0..512)
      const dims = { width: 4096, height: 4096, dpi: 300 };
      const transform = { pan: { x: 2048, y: 2048 }, zoom: 1, rotation: 0 };

      compositor.render(layers, transform, dims, grid, {
        dimensions: dims,
        devicePixelRatio: 1,
      });
      compositor.render(layers, transform, dims, grid, {
        dimensions: dims,
        devicePixelRatio: 1,
      });

      // Reusable ImageData allocated ONCE total across all tiles & frames!
      expect(createImageDataCalls).toBe(1);
      // Pixelated filtering applied in 2D mode
      expect(mock2DCtx.imageSmoothingEnabled).toBe(false);
      // Off-screen tiles (10,10) and (11,11) were culled (never drawn at x >= 2560)
      expect(drawImagePositions.length).toBeGreaterThan(0);
      expect(drawImagePositions.every((p) => p.x < 1024 && p.y < 1024)).toBe(true);

      compositor.dispose();
    } finally {
      (globalThis as any).document = origDocument;
    }
  });

  it('DocumentStore and performanceManager purge tiles, undo steps, and GPU caches', async () => {
    const store = new DocumentStore({ totalTileBudgetMb: 64, offloadInactiveUndoOnSwitch: true });
    const s1 = store.getOrCreateSession('doc-a');
    const s2 = store.getOrCreateSession('doc-b');

    const t1 = createTileBuffer('l1', 0, 0, 'color-32bit', 0);
    t1.data!.fill(128);
    s1.tileGrid.setTile('l1', 0, 0, t1);

    const t2 = createTileBuffer('l2', 0, 0, 'color-32bit', 0);
    t2.data!.fill(200);
    s2.tileGrid.setTile('l2', 0, 0, t2);

    store.setActiveDocument('doc-b');
    expect(store.getTotalActiveTileBytes()).toBeGreaterThan(0);

    let gpuFlushed = false;
    performanceManager.registerCompositorHooks({
      getTelemetry: () => ({
        backend: 'webgl2',
        rendererName: 'Mock RTX',
        arrayPoolUsed: 12,
        arrayPoolCapacity: GPU_TEXTURE_POOL_CONFIGS.high.arrayLayers,
        texture2DPoolUsed: 0,
        estimatedVramMb: 128,
        stackCacheHits: 42,
        stackCacheRebuilds: 2,
      }),
      flushGpuCaches: () => {
        gpuFlushed = true;
      },
    });
    performanceManager.registerMemoryHooks({
      getActiveTileBytes: () => store.getTotalActiveTileBytes(),
      getTileBudgetBytes: () => store.getTileBudgetBytes(),
      getUndoStats: () => store.getUndoMemoryStats(),
      getActiveSessionIds: () => store.getActiveSessionIds(),
      purgeTiles: () => store.purgeTileMemory(),
      purgeUndo: () => store.purgeUndoMemory(),
    });

    const beforeTelemetry = await performanceManager.getMemoryTelemetry();
    expect(beforeTelemetry.compositor.rendererName).toBe('Mock RTX');
    expect(beforeTelemetry.tileBudgetMb).toBe(64);

    const purgeRes = await performanceManager.purgeMemory('all');
    expect(purgeRes.flushedGpuTextures).toBe(true);
    expect(gpuFlushed).toBe(true);
    // Inactive session doc-a had its tile evicted to scratch disk
    expect(s1.tileGrid.getMemoryManager()!.getActiveMemoryBytes()).toBe(0);

    performanceManager.registerCompositorHooks(null);
    performanceManager.registerMemoryHooks(null);
    await store.clearAllSessions();
  });

  it('renders PerformanceSettingsTab safely even with stale/partial pre-HMR settings in desktop and web modes', () => {
    const staleLegacySettings = {
      themePreset: 'modern',
      modernAccent: 'purple',
      tileMemoryBudgetMb: 1024,
    } as unknown as AppSettings;

    const htmlDesktop = renderToStaticMarkup(
      React.createElement(PerformanceSettingsTab, {
        settings: staleLegacySettings,
        isDesktopTauri: true,
        onUpdateSettings: () => {},
        onShowToast: () => {},
      })
    );
    expect(htmlDesktop).toContain('performance-settings-tab');
    expect(htmlDesktop).toContain('Automatic Settings');
    expect(htmlDesktop).toContain('Memory Usage (Max RAM)');
    expect(htmlDesktop).toContain('Graphics &amp; Rendering');
    expect(htmlDesktop).toContain('Advanced Settings');

    const htmlWeb = renderToStaticMarkup(
      React.createElement(PerformanceSettingsTab, {
        settings: DEFAULT_APP_SETTINGS,
        isDesktopTauri: false,
        onUpdateSettings: () => {},
        onShowToast: () => {},
      })
    );
    expect(htmlWeb).toContain('performance-settings-tab');
    expect(htmlWeb).toContain('Automatic Settings');
    expect(htmlWeb).toContain('Free Memory');
  });

  it('auto-calibrates recommended settings for low-RAM, workstation, and software-only GPUs', () => {
    // 4 GB laptop with integrated GPU
    const lowRam = computeRecommendedSettings({
      totalRamMb: 4096,
      cpuLogicalCores: 4,
      gpus: [{ id: 'g0', name: 'Intel UHD 620', vendor: 'Intel', vramMb: 128, kind: 'integrated', isPrimary: true }],
      activeWebGl: {
        available: true,
        renderer: 'ANGLE (Intel UHD 620)',
        vendor: 'Intel',
        glVersion: 'WebGL 2.0',
        maxTextureSize: 8192,
        maxArrayLayers: 256,
      },
    });
    expect(lowRam.settings.autoOptimizePerformance).toBe(true);
    expect(lowRam.settings.gpuTexturePoolPreset).toBe('low');
    expect(lowRam.settings.viewportResolutionScale).toBe('1x');
    expect(lowRam.settings.tileMemoryBudgetMb).toBe(2048);

    // 32 GB workstation with discrete RTX GPU
    const workstation = computeRecommendedSettings({
      totalRamMb: 32768,
      cpuLogicalCores: 16,
      gpus: [{ id: 'g0', name: 'NVIDIA GeForce RTX 4080', vendor: 'NVIDIA', vramMb: 16384, kind: 'discrete', isPrimary: true }],
      activeWebGl: {
        available: true,
        renderer: 'ANGLE (NVIDIA GeForce RTX 4080)',
        vendor: 'NVIDIA',
        glVersion: 'WebGL 2.0',
        maxTextureSize: 16384,
        maxArrayLayers: 2048,
      },
    });
    expect(workstation.settings.gpuTexturePoolPreset).toBe('ultra');
    expect(workstation.settings.gpuPowerPreference).toBe('high-performance');
    expect(workstation.settings.preview3DMaxResolution).toBe(2560);
    expect(workstation.settings.undoRamSteps).toBe(25);

    // Software-only / no hardware GPU
    const softwareOnly = computeRecommendedSettings({
      totalRamMb: 8192,
      cpuLogicalCores: 4,
      gpus: [{ id: 'g0', name: 'Microsoft Basic Render Driver', vendor: 'Microsoft', vramMb: 0, kind: 'software', isPrimary: true }],
      activeWebGl: {
        available: true,
        renderer: 'Google SwiftShader',
        vendor: 'Google',
        glVersion: 'WebGL 2.0',
        maxTextureSize: 4096,
        maxArrayLayers: 256,
      },
    });
    expect(softwareOnly.settings.renderBackend).toBe('canvas2d');
    expect(softwareOnly.settings.gpuBrushAcceleration).toBe(false);
    expect(softwareOnly.settings.layerStackCaching).toBe(false);
  });
});
