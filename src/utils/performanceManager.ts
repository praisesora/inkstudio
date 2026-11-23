/**
 * Central Runtime Performance, Hardware Telemetry & Optimization Manager
 *
 * Bridges AppSettings (RAM allocation, GPU renderer & power preference, VRAM cache pool,
 * HiDPI scaling, CPU worker thread limits, and Scratch Disk settings) to:
 * - ViewportCompositor (WebGL2 / Canvas2D)
 * - WebGlBrushEngine & BrushEngine
 * - DocumentStore (Tile RAM & Undo RAM budgets)
 * - Rust Tauri desktop backend (hardware telemetry, Rayon worker pool, custom scratch disk, WebView2 GPU flags)
 */

import {
  AppSettings,
  CanvasFilteringQuality,
  DEFAULT_APP_SETTINGS,
  DesktopGraphicsApi,
  GpuPowerPreference,
  GpuTexturePoolPreset,
  PerformancePresetId,
  Preview3DMaxResolution,
  RenderBackend,
  ScratchDiskCompression,
  ViewportResolutionScale,
} from '../types/settings';
import { isTauriEnvironment } from './tileEngine/scratchDriver';

export interface GpuAdapterInfo {
  id: string;
  name: string;
  vendor: string;
  vramMb: number;
  kind: 'discrete' | 'integrated' | 'software' | 'unknown';
  isPrimary: boolean;
}

export interface ActiveWebGlInfo {
  available: boolean;
  renderer: string;
  vendor: string;
  glVersion: string;
  maxTextureSize: number;
  maxArrayLayers: number;
}

export interface StartupPerformanceConfig {
  gpuPowerPreference: GpuPowerPreference;
  desktopGraphicsApi: DesktopGraphicsApi;
  scratchDiskPath: string;
  scratchDiskCompression: ScratchDiskCompression;
  cpuWorkerThreads: number;
}

export interface SystemHardwareInfo {
  totalRamMb: number;
  availableRamMb: number;
  cpuLogicalCores: number;
  osPlatform: string;
  isDesktop: boolean;
  gpus: GpuAdapterInfo[];
  activeWebGl: ActiveWebGlInfo;
  scratchDiskPath: string;
  scratchDiskFreeMb: number;
  scratchDiskTotalMb: number;
  scratchDiskUsedBytes: number;
  undoCacheUsedBytes: number;
  activeCpuWorkerThreads: number;
  startupConfig: StartupPerformanceConfig;
}

export interface GpuTexturePoolSpec {
  arrayLayers: number;
  maxTexture2D: number;
  estimatedVramMb: number;
  label: string;
}

export const GPU_TEXTURE_POOL_CONFIGS: Record<GpuTexturePoolPreset, GpuTexturePoolSpec> = {
  low: {
    arrayLayers: 128,
    maxTexture2D: 512,
    estimatedVramMb: 32,
    label: 'Low (32 MB)',
  },
  balanced: {
    arrayLayers: 256,
    maxTexture2D: 1024,
    estimatedVramMb: 64,
    label: 'Balanced (64 MB)',
  },
  high: {
    arrayLayers: 512,
    maxTexture2D: 2048,
    estimatedVramMb: 128,
    label: 'High (128 MB)',
  },
  ultra: {
    arrayLayers: 1024,
    maxTexture2D: 4096,
    estimatedVramMb: 256,
    label: 'Ultra (256 MB)',
  },
};

export interface RuntimePerformanceConfig {
  autoOptimizePerformance: boolean;
  tileMemoryBudgetMb: number;
  memoryAllocationPercent: number;
  maxHistorySteps: number;
  undoRamSteps: number;
  offloadInactiveTabs: boolean;
  renderBackend: RenderBackend;
  gpuPowerPreference: GpuPowerPreference;
  desktopGraphicsApi: DesktopGraphicsApi;
  gpuBrushAcceleration: boolean;
  gpuTexturePoolPreset: GpuTexturePoolPreset;
  layerStackCaching: boolean;
  viewportResolutionScale: ViewportResolutionScale;
  canvasFilteringQuality: CanvasFilteringQuality;
  scratchDiskPath: string;
  scratchDiskCompression: ScratchDiskCompression;
  cpuWorkerThreads: number;
  useNativeRustAcceleration: boolean;
  preview3DMaxResolution: Preview3DMaxResolution;
  preview3DAntialias: boolean;
}

export interface CompositorTelemetry {
  backend: 'webgl2' | 'canvas2d';
  rendererName: string;
  arrayPoolUsed: number;
  arrayPoolCapacity: number;
  texture2DPoolUsed: number;
  estimatedVramMb: number;
  stackCacheHits: number;
  stackCacheRebuilds: number;
}

export interface LiveMemoryTelemetry {
  activeTileMb: number;
  tileBudgetMb: number;
  tilePercent: number;
  ramUndoSteps: number;
  diskUndoSteps: number;
  compressedRamUndoMb: number;
  scratchDiskUsedMb: number;
  undoDiskUsedMb: number;
  jsHeapUsedMb: number | null;
  jsHeapLimitMb: number | null;
  compositor: CompositorTelemetry;
}

export type PurgeScope = 'tiles' | 'undo' | 'gpu' | 'scratch' | 'all';

export interface PurgeResult {
  freedTileMb: number;
  offloadedUndoSteps: number;
  flushedGpuTextures: boolean;
  freedScratchDiskMb: number;
}

export interface AdobeMemoryLimits {
  totalRamMb: number;
  minMb: number;
  maxMb: number;
  idealMinMb: number;
  idealMaxMb: number;
  idealMinPercent: number;
  idealMaxPercent: number;
}

export function extractPerformanceConfig(settings: AppSettings): RuntimePerformanceConfig {
  return {
    autoOptimizePerformance:
      settings.autoOptimizePerformance ?? DEFAULT_APP_SETTINGS.autoOptimizePerformance,
    tileMemoryBudgetMb: settings.tileMemoryBudgetMb || DEFAULT_APP_SETTINGS.tileMemoryBudgetMb,
    memoryAllocationPercent:
      settings.memoryAllocationPercent ?? DEFAULT_APP_SETTINGS.memoryAllocationPercent,
    maxHistorySteps: settings.maxHistorySteps ?? DEFAULT_APP_SETTINGS.maxHistorySteps,
    undoRamSteps: settings.undoRamSteps ?? DEFAULT_APP_SETTINGS.undoRamSteps,
    offloadInactiveTabs: settings.offloadInactiveTabs ?? DEFAULT_APP_SETTINGS.offloadInactiveTabs,
    renderBackend: settings.renderBackend ?? DEFAULT_APP_SETTINGS.renderBackend,
    gpuPowerPreference: settings.gpuPowerPreference ?? DEFAULT_APP_SETTINGS.gpuPowerPreference,
    desktopGraphicsApi: settings.desktopGraphicsApi ?? DEFAULT_APP_SETTINGS.desktopGraphicsApi,
    gpuBrushAcceleration:
      settings.gpuBrushAcceleration ?? DEFAULT_APP_SETTINGS.gpuBrushAcceleration,
    gpuTexturePoolPreset:
      settings.gpuTexturePoolPreset ?? DEFAULT_APP_SETTINGS.gpuTexturePoolPreset,
    layerStackCaching: settings.layerStackCaching ?? DEFAULT_APP_SETTINGS.layerStackCaching,
    viewportResolutionScale:
      settings.viewportResolutionScale ?? DEFAULT_APP_SETTINGS.viewportResolutionScale,
    canvasFilteringQuality:
      settings.canvasFilteringQuality ?? DEFAULT_APP_SETTINGS.canvasFilteringQuality,
    scratchDiskPath: settings.scratchDiskPath ?? DEFAULT_APP_SETTINGS.scratchDiskPath,
    scratchDiskCompression:
      settings.scratchDiskCompression ?? DEFAULT_APP_SETTINGS.scratchDiskCompression,
    cpuWorkerThreads: settings.cpuWorkerThreads ?? DEFAULT_APP_SETTINGS.cpuWorkerThreads,
    useNativeRustAcceleration:
      settings.useNativeRustAcceleration ?? DEFAULT_APP_SETTINGS.useNativeRustAcceleration,
    preview3DMaxResolution:
      settings.preview3DMaxResolution ?? DEFAULT_APP_SETTINGS.preview3DMaxResolution,
    preview3DAntialias: settings.preview3DAntialias ?? DEFAULT_APP_SETTINGS.preview3DAntialias,
  };
}

/**
 * Computes Adobe Photoshop-style RAM allocation bounds based on detected system memory.
 */
export function computeAdobeMemoryLimits(totalRamMb: number): AdobeMemoryLimits {
  const safeTotal = Math.max(2048, Math.round(totalRamMb || 8192));
  const minMb = 256;
  const maxMb = Math.min(32768, Math.max(1024, Math.floor((safeTotal * 0.85) / 128) * 128));
  const idealMinMb = Math.max(minMb, Math.floor((safeTotal * 0.5) / 128) * 128);
  const idealMaxMb = Math.min(maxMb, Math.max(idealMinMb + 128, Math.floor((safeTotal * 0.7) / 128) * 128));
  return {
    totalRamMb: safeTotal,
    minMb,
    maxMb,
    idealMinMb,
    idealMaxMb,
    idealMinPercent: 50,
    idealMaxPercent: 70,
  };
}

export function memoryPercentToMb(percent: number, totalRamMb: number): number {
  const limits = computeAdobeMemoryLimits(totalRamMb);
  const clampedPct = Math.max(20, Math.min(85, percent));
  const raw = Math.round(((limits.totalRamMb * clampedPct) / 100) / 128) * 128;
  return Math.max(limits.minMb, Math.min(limits.maxMb, raw));
}

export function memoryMbToPercent(mb: number, totalRamMb: number): number {
  const safeTotal = Math.max(2048, totalRamMb || 8192);
  return Math.max(20, Math.min(85, Math.round((mb / safeTotal) * 100)));
}

/**
 * Computes effective viewport devicePixelRatio from the user's HiDPI scaling setting.
 */
export function resolveEffectiveDpr(
  rawDpr: number,
  scale: ViewportResolutionScale = 'capped-2x'
): number {
  const safeRaw = Number.isFinite(rawDpr) && rawDpr > 0 ? rawDpr : 1;
  switch (scale) {
    case 'native':
      return safeRaw;
    case 'capped-2x':
      return Math.min(safeRaw, 2);
    case '1x':
      return 1;
    case '0.75x':
      return 0.75;
    default:
      return Math.min(safeRaw, 2);
  }
}

export interface RecommendedPerformanceResult {
  settings: Partial<AppSettings>;
  profileLabel: string;
  summary: string;
}

function isSoftwareRendererString(name: string): boolean {
  const lower = (name || '').toLowerCase();
  return (
    lower.includes('swiftshader') ||
    lower.includes('llvmpipe') ||
    lower.includes('microsoft basic') ||
    lower.includes('software') ||
    lower.includes('warp')
  );
}

/**
 * Automatically calculates optimal Ink Studio performance settings from detected hardware
 * (System RAM, GPU class/VRAM, WebGL2 availability, and CPU cores) so users never have to tune manually.
 */
export function computeRecommendedSettings(
  hw: Pick<SystemHardwareInfo, 'totalRamMb' | 'cpuLogicalCores' | 'gpus' | 'activeWebGl'>
): RecommendedPerformanceResult {
  const totalRamMb = Math.max(2048, Math.round(hw.totalRamMb || 8192));
  const gpus = Array.isArray(hw.gpus) ? hw.gpus : [];
  const hasDiscreteGpu = gpus.some((g) => g.kind === 'discrete');
  const maxDiscreteVramMb = gpus
    .filter((g) => g.kind === 'discrete')
    .reduce((max, g) => Math.max(max, g.vramMb || 0), 0);

  const webglAvailable = Boolean(hw.activeWebGl?.available);
  const webglIsSoftware =
    !webglAvailable || isSoftwareRendererString(hw.activeWebGl?.renderer || '');
  const onlySoftwareGpu =
    webglIsSoftware && (gpus.length === 0 || gpus.every((g) => g.kind === 'software'));

  // Software-only / no hardware GPU fallback
  if (onlySoftwareGpu) {
    const percent = totalRamMb <= 4096 ? 45 : 55;
    const budgetMb = memoryPercentToMb(percent, totalRamMb);
    return {
      profileLabel: 'Auto (CPU Safe)',
      summary: `${Math.round(budgetMb / 102.4) / 10 >= 1 ? `${(budgetMb / 1024).toFixed(1)} GB` : `${budgetMb} MB`} RAM · Canvas 2D CPU · 1× Scale`,
      settings: {
        autoOptimizePerformance: true,
        memoryAllocationPercent: percent,
        tileMemoryBudgetMb: budgetMb,
        undoRamSteps: totalRamMb <= 4096 ? 8 : 12,
        offloadInactiveTabs: true,
        renderBackend: 'canvas2d',
        gpuPowerPreference: 'default',
        desktopGraphicsApi: 'auto',
        gpuBrushAcceleration: false,
        gpuTexturePoolPreset: 'low',
        layerStackCaching: false,
        viewportResolutionScale: '1x',
        canvasFilteringQuality: 'auto',
        scratchDiskCompression: 'lz4',
        cpuWorkerThreads: 0,
        useNativeRustAcceleration: true,
        preview3DMaxResolution: 1024,
        preview3DAntialias: false,
      },
    };
  }

  // Tiered hardware calibration based on system RAM & GPU class
  let percent = 60;
  let undoRamSteps = 15;
  let gpuTexturePoolPreset: GpuTexturePoolPreset = 'balanced';
  let viewportResolutionScale: ViewportResolutionScale = 'capped-2x';
  let preview3DMaxResolution: Preview3DMaxResolution = 1920;
  let preview3DAntialias = true;
  let profileLabel = 'Auto (Balanced)';

  if (totalRamMb <= 4096) {
    percent = 50;
    undoRamSteps = 8;
    gpuTexturePoolPreset = 'low';
    viewportResolutionScale = '1x';
    preview3DMaxResolution = 1024;
    preview3DAntialias = false;
    profileLabel = 'Auto (Compact RAM)';
  } else if (totalRamMb <= 8192) {
    percent = 55;
    undoRamSteps = 12;
    gpuTexturePoolPreset = hasDiscreteGpu ? 'high' : 'balanced';
    viewportResolutionScale = 'capped-2x';
    preview3DMaxResolution = 1920;
    preview3DAntialias = true;
    profileLabel = 'Auto (Standard)';
  } else if (totalRamMb >= 24576 && (hasDiscreteGpu || (hw.activeWebGl?.maxArrayLayers ?? 0) >= 1024)) {
    percent = 65;
    undoRamSteps = 25;
    gpuTexturePoolPreset =
      hasDiscreteGpu && (maxDiscreteVramMb === 0 || maxDiscreteVramMb >= 4096) ? 'ultra' : 'high';
    viewportResolutionScale = 'capped-2x';
    preview3DMaxResolution = 2560;
    preview3DAntialias = true;
    profileLabel = 'Auto (Workstation)';
  } else {
    // 16 GB class
    percent = 60;
    undoRamSteps = 18;
    gpuTexturePoolPreset = hasDiscreteGpu ? 'high' : 'balanced';
    viewportResolutionScale = 'capped-2x';
    preview3DMaxResolution = 1920;
    preview3DAntialias = true;
    profileLabel = hasDiscreteGpu ? 'Auto (High GPU)' : 'Auto (Balanced)';
  }

  const budgetMb = memoryPercentToMb(percent, totalRamMb);
  const ramLabel =
    budgetMb >= 1024
      ? `${(budgetMb / 1024).toFixed(budgetMb % 1024 === 0 ? 0 : 1)} GB`
      : `${budgetMb} MB`;
  const gpuLabel = hasDiscreteGpu ? 'Dedicated GPU' : 'WebGL2 GPU';
  const poolLabel = GPU_TEXTURE_POOL_CONFIGS[gpuTexturePoolPreset].label;

  return {
    profileLabel,
    summary: `${ramLabel} RAM · ${gpuLabel} · ${poolLabel} Cache`,
    settings: {
      autoOptimizePerformance: true,
      memoryAllocationPercent: percent,
      tileMemoryBudgetMb: budgetMb,
      undoRamSteps,
      offloadInactiveTabs: true,
      renderBackend: 'auto',
      gpuPowerPreference: hasDiscreteGpu ? 'high-performance' : 'default',
      desktopGraphicsApi: 'auto',
      gpuBrushAcceleration: true,
      gpuTexturePoolPreset,
      layerStackCaching: true,
      viewportResolutionScale,
      canvasFilteringQuality: 'auto',
      scratchDiskCompression: 'lz4',
      cpuWorkerThreads: 0,
      useNativeRustAcceleration: true,
      preview3DMaxResolution,
      preview3DAntialias,
    },
  };
}

/**
 * Generates an optimized bundle of performance settings calibrated to the host machine's RAM.
 */
export function buildPerformancePreset(
  preset: PerformancePresetId,
  totalRamMb: number = 8192
): Partial<AppSettings> {
  switch (preset) {
    case 'battery': {
      const percent = 40;
      return {
        autoOptimizePerformance: false,
        memoryAllocationPercent: percent,
        tileMemoryBudgetMb: memoryPercentToMb(percent, totalRamMb),
        undoRamSteps: 8,
        offloadInactiveTabs: true,
        renderBackend: 'auto',
        gpuPowerPreference: 'low-power',
        gpuBrushAcceleration: true,
        gpuTexturePoolPreset: 'low',
        layerStackCaching: true,
        viewportResolutionScale: '1x',
        canvasFilteringQuality: 'auto',
        scratchDiskCompression: 'lz4',
        preview3DMaxResolution: 1024,
        preview3DAntialias: false,
      };
    }
    case 'maximum': {
      const percent = 70;
      return {
        autoOptimizePerformance: false,
        memoryAllocationPercent: percent,
        tileMemoryBudgetMb: memoryPercentToMb(percent, totalRamMb),
        undoRamSteps: 25,
        offloadInactiveTabs: true,
        renderBackend: 'webgl2',
        gpuPowerPreference: 'high-performance',
        gpuBrushAcceleration: true,
        gpuTexturePoolPreset: totalRamMb >= 16384 ? 'ultra' : 'high',
        layerStackCaching: true,
        viewportResolutionScale: 'native',
        canvasFilteringQuality: 'auto',
        scratchDiskCompression: 'lz4',
        cpuWorkerThreads: 0,
        useNativeRustAcceleration: true,
        preview3DMaxResolution: 2560,
        preview3DAntialias: true,
      };
    }
    case 'compatibility': {
      const percent = 50;
      return {
        autoOptimizePerformance: false,
        memoryAllocationPercent: percent,
        tileMemoryBudgetMb: memoryPercentToMb(percent, totalRamMb),
        undoRamSteps: 10,
        offloadInactiveTabs: true,
        renderBackend: 'canvas2d',
        gpuPowerPreference: 'default',
        gpuBrushAcceleration: false,
        gpuTexturePoolPreset: 'low',
        layerStackCaching: false,
        viewportResolutionScale: '1x',
        canvasFilteringQuality: 'auto',
        scratchDiskCompression: 'lz4',
        preview3DMaxResolution: 1024,
        preview3DAntialias: false,
      };
    }
    case 'balanced':
    default: {
      const percent = 60;
      return {
        autoOptimizePerformance: false,
        memoryAllocationPercent: percent,
        tileMemoryBudgetMb: memoryPercentToMb(percent, totalRamMb),
        undoRamSteps: 15,
        offloadInactiveTabs: true,
        renderBackend: 'auto',
        gpuPowerPreference: 'high-performance',
        gpuBrushAcceleration: true,
        gpuTexturePoolPreset: 'balanced',
        layerStackCaching: true,
        viewportResolutionScale: 'capped-2x',
        canvasFilteringQuality: 'auto',
        scratchDiskCompression: 'lz4',
        cpuWorkerThreads: 0,
        useNativeRustAcceleration: true,
        preview3DMaxResolution: 1920,
        preview3DAntialias: true,
      };
    }
  }
}

export function probeWebGlRenderer(
  powerPreference: GpuPowerPreference = 'high-performance'
): ActiveWebGlInfo {
  if (typeof document === 'undefined') {
    return {
      available: false,
      renderer: 'CPU Software (Headless)',
      vendor: 'Standard',
      glVersion: 'None',
      maxTextureSize: 0,
      maxArrayLayers: 0,
    };
  }
  try {
    const canvas = document.createElement('canvas');
    canvas.width = 1;
    canvas.height = 1;
    const gl = canvas.getContext('webgl2', {
      powerPreference,
      alpha: true,
      antialias: false,
      depth: false,
      stencil: false,
    }) as WebGL2RenderingContext | null;
    if (!gl) {
      return {
        available: false,
        renderer: 'Canvas 2D (WebGL2 Unavailable)',
        vendor: 'Standard',
        glVersion: 'None',
        maxTextureSize: 0,
        maxArrayLayers: 0,
      };
    }

    let renderer = 'WebGL2 Hardware GPU';
    let vendor = 'Generic';
    if (typeof gl.getExtension === 'function') {
      const debugExt = gl.getExtension('WEBGL_debug_renderer_info');
      if (debugExt) {
        renderer = String(gl.getParameter(debugExt.UNMASKED_RENDERER_WEBGL) || renderer);
        vendor = String(gl.getParameter(debugExt.UNMASKED_VENDOR_WEBGL) || vendor);
      }
    }
    const glVersion = String(gl.getParameter(gl.VERSION) || 'WebGL 2.0');
    const maxTextureSize = Number(gl.getParameter(gl.MAX_TEXTURE_SIZE)) || 4096;
    const maxArrayLayers = Number(gl.getParameter(gl.MAX_ARRAY_TEXTURE_LAYERS)) || 256;

    // Immediately free probe WebGL context so we don't leak context slots
    const loseExt = gl.getExtension?.('WEBGL_lose_context');
    loseExt?.loseContext?.();
    canvas.width = 0;
    canvas.height = 0;

    return {
      available: true,
      renderer,
      vendor,
      glVersion,
      maxTextureSize,
      maxArrayLayers,
    };
  } catch {
    return {
      available: false,
      renderer: 'Canvas 2D Fallback',
      vendor: 'Standard',
      glVersion: 'None',
      maxTextureSize: 0,
      maxArrayLayers: 0,
    };
  }
}

export interface RegisteredCompositorHooks {
  getTelemetry: () => CompositorTelemetry;
  flushGpuCaches: () => void;
}

export interface RegisteredMemoryHooks {
  getActiveTileBytes: () => number;
  getTileBudgetBytes: () => number;
  getUndoStats: () => { ramSteps: number; diskSteps: number; compressedRamBytes: number };
  getActiveSessionIds: () => string[];
  purgeTiles: () => Promise<number>;
  purgeUndo: () => Promise<number>;
  flushBrushGpuCaches?: () => void;
}

type PerfListener = (config: RuntimePerformanceConfig) => void;

class PerformanceManager {
  private config: RuntimePerformanceConfig = extractPerformanceConfig(DEFAULT_APP_SETTINGS);
  private listeners: Set<PerfListener> = new Set();
  private cachedHardwareInfo: SystemHardwareInfo | null = null;
  private compositorHooks: RegisteredCompositorHooks | null = null;
  private memoryHooks: RegisteredMemoryHooks | null = null;
  private invokePromise: Promise<typeof import('@tauri-apps/api/core').invoke> | null = null;
  private lastAppliedStartupConfig: StartupPerformanceConfig | null = null;

  private getInvoke(): Promise<typeof import('@tauri-apps/api/core').invoke> {
    if (!this.invokePromise) {
      this.invokePromise = import('@tauri-apps/api/core').then((m) => m.invoke);
    }
    return this.invokePromise;
  }

  public getConfig(): RuntimePerformanceConfig {
    return this.config;
  }

  public subscribe(listener: PerfListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  public applySettings(settings: AppSettings): RuntimePerformanceConfig {
    const next = extractPerformanceConfig(settings);
    this.config = next;
    for (const listener of Array.from(this.listeners)) {
      try {
        listener(next);
      } catch (err) {
        console.warn('[PerformanceManager] listener error:', err);
      }
    }
    return next;
  }

  public registerCompositorHooks(hooks: RegisteredCompositorHooks | null): void {
    this.compositorHooks = hooks;
  }

  public registerMemoryHooks(hooks: RegisteredMemoryHooks | null): void {
    this.memoryHooks = hooks;
  }

  public needsRestartForDesktopGpuFlags(settings: AppSettings): boolean {
    if (!isTauriEnvironment() || !this.lastAppliedStartupConfig) return false;
    return (
      this.lastAppliedStartupConfig.gpuPowerPreference !== settings.gpuPowerPreference ||
      this.lastAppliedStartupConfig.desktopGraphicsApi !== settings.desktopGraphicsApi
    );
  }

  public async detectHardwareInfo(forceRefresh = false): Promise<SystemHardwareInfo> {
    if (this.cachedHardwareInfo && !forceRefresh) {
      return this.cachedHardwareInfo;
    }

    const activeWebGl = probeWebGlRenderer(this.config.gpuPowerPreference);

    if (isTauriEnvironment()) {
      try {
        const invoke = await this.getInvoke();
        const native = await invoke<{
          totalRamMb: number;
          availableRamMb: number;
          cpuLogicalCores: number;
          osPlatform: string;
          gpus: GpuAdapterInfo[];
          scratchDiskPath: string;
          scratchDiskFreeMb: number;
          scratchDiskTotalMb: number;
          scratchDiskUsedBytes: number;
          undoCacheUsedBytes: number;
          activeCpuWorkerThreads: number;
          startupConfig: StartupPerformanceConfig;
        }>('get_system_hardware_info');

        if (!this.lastAppliedStartupConfig && native.startupConfig) {
          this.lastAppliedStartupConfig = { ...native.startupConfig };
        }

        const gpus: GpuAdapterInfo[] =
          native.gpus && native.gpus.length > 0
            ? native.gpus
            : activeWebGl.available
              ? [
                  {
                    id: 'webgl-active',
                    name: activeWebGl.renderer,
                    vendor: activeWebGl.vendor,
                    vramMb: 0,
                    kind: 'unknown',
                    isPrimary: true,
                  },
                ]
              : [];

        const info: SystemHardwareInfo = {
          totalRamMb: native.totalRamMb || 8192,
          availableRamMb: native.availableRamMb || 4096,
          cpuLogicalCores: native.cpuLogicalCores || 4,
          osPlatform: native.osPlatform || 'desktop',
          isDesktop: true,
          gpus,
          activeWebGl,
          scratchDiskPath: native.scratchDiskPath || '',
          scratchDiskFreeMb: native.scratchDiskFreeMb || 0,
          scratchDiskTotalMb: native.scratchDiskTotalMb || 0,
          scratchDiskUsedBytes: native.scratchDiskUsedBytes || 0,
          undoCacheUsedBytes: native.undoCacheUsedBytes || 0,
          activeCpuWorkerThreads: native.activeCpuWorkerThreads || 0,
          startupConfig: native.startupConfig || {
            gpuPowerPreference: this.config.gpuPowerPreference,
            desktopGraphicsApi: this.config.desktopGraphicsApi,
            scratchDiskPath: this.config.scratchDiskPath,
            scratchDiskCompression: this.config.scratchDiskCompression,
            cpuWorkerThreads: this.config.cpuWorkerThreads,
          },
        };
        this.cachedHardwareInfo = info;
        return info;
      } catch (err) {
        console.warn('[PerformanceManager] Failed to query native hardware info:', err);
      }
    }

    // Web / Browser fallback telemetry
    const nav = typeof navigator !== 'undefined' ? (navigator as Navigator & { deviceMemory?: number }) : null;
    const deviceMemGb = typeof nav?.deviceMemory === 'number' && nav.deviceMemory > 0 ? nav.deviceMemory : 8;
    const totalRamMb = Math.round(deviceMemGb * 1024);
    const cores = typeof nav?.hardwareConcurrency === 'number' && nav.hardwareConcurrency > 0 ? nav.hardwareConcurrency : 4;

    const webGpus: GpuAdapterInfo[] = activeWebGl.available
      ? [
          {
            id: 'webgl-primary',
            name: activeWebGl.renderer,
            vendor: activeWebGl.vendor,
            vramMb: 0,
            kind: 'unknown',
            isPrimary: true,
          },
        ]
      : [];

    const webInfo: SystemHardwareInfo = {
      totalRamMb,
      availableRamMb: Math.round(totalRamMb * 0.65),
      cpuLogicalCores: cores,
      osPlatform: 'web',
      isDesktop: false,
      gpus: webGpus,
      activeWebGl,
      scratchDiskPath: 'Browser In-Memory (IndexedDB / LZ4)',
      scratchDiskFreeMb: 0,
      scratchDiskTotalMb: 0,
      scratchDiskUsedBytes: 0,
      undoCacheUsedBytes: 0,
      activeCpuWorkerThreads: 0,
      startupConfig: {
        gpuPowerPreference: this.config.gpuPowerPreference,
        desktopGraphicsApi: this.config.desktopGraphicsApi,
        scratchDiskPath: '',
        scratchDiskCompression: this.config.scratchDiskCompression,
        cpuWorkerThreads: this.config.cpuWorkerThreads,
      },
    };
    this.cachedHardwareInfo = webInfo;
    return webInfo;
  }

  public async syncDesktopBackendConfig(
    settings: AppSettings
  ): Promise<{ ok: boolean; info?: SystemHardwareInfo; error?: string }> {
    if (!isTauriEnvironment()) {
      return { ok: true };
    }
    try {
      const invoke = await this.getInvoke();
      const payload: StartupPerformanceConfig = {
        gpuPowerPreference: settings.gpuPowerPreference,
        desktopGraphicsApi: settings.desktopGraphicsApi,
        scratchDiskPath: settings.scratchDiskPath || '',
        scratchDiskCompression: settings.scratchDiskCompression,
        cpuWorkerThreads: settings.cpuWorkerThreads,
      };
      const native = await invoke<{
        totalRamMb: number;
        availableRamMb: number;
        cpuLogicalCores: number;
        osPlatform: string;
        gpus: GpuAdapterInfo[];
        scratchDiskPath: string;
        scratchDiskFreeMb: number;
        scratchDiskTotalMb: number;
        scratchDiskUsedBytes: number;
        undoCacheUsedBytes: number;
        activeCpuWorkerThreads: number;
        startupConfig: StartupPerformanceConfig;
      }>('apply_performance_config', { config: payload });

      const activeWebGl = this.cachedHardwareInfo?.activeWebGl ?? probeWebGlRenderer(settings.gpuPowerPreference);
      const info: SystemHardwareInfo = {
        ...native,
        isDesktop: true,
        activeWebGl,
      };
      this.cachedHardwareInfo = info;
      return { ok: true, info };
    } catch (err) {
      return {
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  public async getMemoryTelemetry(): Promise<LiveMemoryTelemetry> {
    const activeTileBytes = this.memoryHooks?.getActiveTileBytes() ?? 0;
    const tileBudgetBytes =
      this.memoryHooks?.getTileBudgetBytes() ?? this.config.tileMemoryBudgetMb * 1024 * 1024;
    const undoStats = this.memoryHooks?.getUndoStats() ?? {
      ramSteps: 0,
      diskSteps: 0,
      compressedRamBytes: 0,
    };

    let scratchDiskUsedBytes = this.cachedHardwareInfo?.scratchDiskUsedBytes ?? 0;
    let undoDiskUsedBytes = this.cachedHardwareInfo?.undoCacheUsedBytes ?? 0;

    if (isTauriEnvironment()) {
      try {
        const invoke = await this.getInvoke();
        const usage = await invoke<{
          scratchDiskUsedBytes: number;
          undoCacheUsedBytes: number;
          scratchDiskFreeMb: number;
          scratchDiskTotalMb: number;
          scratchDiskPath: string;
        }>('get_scratch_disk_usage');
        scratchDiskUsedBytes = usage.scratchDiskUsedBytes;
        undoDiskUsedBytes = usage.undoCacheUsedBytes;
        if (this.cachedHardwareInfo) {
          this.cachedHardwareInfo = {
            ...this.cachedHardwareInfo,
            scratchDiskPath: usage.scratchDiskPath,
            scratchDiskFreeMb: usage.scratchDiskFreeMb,
            scratchDiskTotalMb: usage.scratchDiskTotalMb,
            scratchDiskUsedBytes: usage.scratchDiskUsedBytes,
            undoCacheUsedBytes: usage.undoCacheUsedBytes,
          };
        }
      } catch {
        // Ignore transient telemetry errors
      }
    }

    const perfMem =
      typeof performance !== 'undefined'
        ? (performance as Performance & {
            memory?: { usedJSHeapSize: number; jsHeapSizeLimit: number };
          }).memory
        : undefined;

    const poolPreset = this.config.gpuTexturePoolPreset;
    const poolSpec =
      (poolPreset && GPU_TEXTURE_POOL_CONFIGS[poolPreset]) || GPU_TEXTURE_POOL_CONFIGS.high;

    const compositor: CompositorTelemetry = this.compositorHooks?.getTelemetry() ?? {
      backend: this.config.renderBackend === 'canvas2d' ? 'canvas2d' : 'webgl2',
      rendererName:
        this.config.renderBackend === 'canvas2d'
          ? 'Canvas 2D (CPU)'
          : this.cachedHardwareInfo?.activeWebGl?.renderer || 'WebGL2',
      arrayPoolUsed: 0,
      arrayPoolCapacity: poolSpec.arrayLayers,
      texture2DPoolUsed: 0,
      estimatedVramMb: 0,
      stackCacheHits: 0,
      stackCacheRebuilds: 0,
    };

    const activeTileMb = Math.round((activeTileBytes / (1024 * 1024)) * 10) / 10;
    const tileBudgetMb = Math.max(1, Math.round(tileBudgetBytes / (1024 * 1024)));

    return {
      activeTileMb,
      tileBudgetMb,
      tilePercent: Math.min(100, Math.round((activeTileMb / tileBudgetMb) * 100)),
      ramUndoSteps: undoStats.ramSteps,
      diskUndoSteps: undoStats.diskSteps,
      compressedRamUndoMb: Math.round((undoStats.compressedRamBytes / (1024 * 1024)) * 10) / 10,
      scratchDiskUsedMb: Math.round((scratchDiskUsedBytes / (1024 * 1024)) * 10) / 10,
      undoDiskUsedMb: Math.round((undoDiskUsedBytes / (1024 * 1024)) * 10) / 10,
      jsHeapUsedMb: perfMem ? Math.round((perfMem.usedJSHeapSize / (1024 * 1024)) * 10) / 10 : null,
      jsHeapLimitMb: perfMem ? Math.round((perfMem.jsHeapSizeLimit / (1024 * 1024)) * 10) / 10 : null,
      compositor,
    };
  }

  public async purgeMemory(scope: PurgeScope = 'all'): Promise<PurgeResult> {
    let freedTileBytes = 0;
    let offloadedUndoSteps = 0;
    let flushedGpuTextures = false;
    let freedScratchBytes = 0;

    if ((scope === 'tiles' || scope === 'all') && this.memoryHooks) {
      freedTileBytes = await this.memoryHooks.purgeTiles();
    }

    if ((scope === 'undo' || scope === 'all') && this.memoryHooks) {
      offloadedUndoSteps = await this.memoryHooks.purgeUndo();
    }

    if (scope === 'gpu' || scope === 'all') {
      if (this.compositorHooks) {
        this.compositorHooks.flushGpuCaches();
        flushedGpuTextures = true;
      }
      if (this.memoryHooks?.flushBrushGpuCaches) {
        this.memoryHooks.flushBrushGpuCaches();
        flushedGpuTextures = true;
      }
    }

    if ((scope === 'scratch' || scope === 'all') && isTauriEnvironment()) {
      try {
        const invoke = await this.getInvoke();
        const activeSessionIds = this.memoryHooks?.getActiveSessionIds() ?? [];
        freedScratchBytes = await invoke<number>('purge_unused_scratch_files', {
          activeSessionIds,
        });
      } catch (err) {
        console.warn('[PerformanceManager] Failed to purge unused scratch files:', err);
      }
    }

    return {
      freedTileMb: Math.round((freedTileBytes / (1024 * 1024)) * 10) / 10,
      offloadedUndoSteps,
      flushedGpuTextures,
      freedScratchDiskMb: Math.round((freedScratchBytes / (1024 * 1024)) * 10) / 10,
    };
  }
}

export const performanceManager = new PerformanceManager();
