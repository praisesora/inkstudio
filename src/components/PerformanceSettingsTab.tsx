import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Sparkles,
  MemoryStick,
  Monitor,
  HardDrive,
  ChevronDown,
  ChevronRight,
  RefreshCw,
  Trash2,
  RotateCw,
  Check,
  AlertTriangle,
  SlidersHorizontal,
} from 'lucide-react';
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
import {
  GPU_TEXTURE_POOL_CONFIGS,
  LiveMemoryTelemetry,
  PurgeScope,
  SystemHardwareInfo,
  buildPerformancePreset,
  computeAdobeMemoryLimits,
  computeRecommendedSettings,
  memoryMbToPercent,
  memoryPercentToMb,
  performanceManager,
} from '../utils/performanceManager';

interface PerformanceSettingsTabProps {
  settings: AppSettings;
  isDesktopTauri: boolean;
  onUpdateSettings: (next: AppSettings) => void;
  onShowToast: (message: string) => void;
}

function formatMb(mb: number): string {
  if (mb >= 1024) {
    return `${(mb / 1024).toFixed(mb % 1024 === 0 ? 0 : 1)} GB`;
  }
  return `${Math.round(mb)} MB`;
}

function formatGpuKindLabel(kind: string): string {
  switch (kind) {
    case 'discrete':
      return 'Dedicated';
    case 'integrated':
      return 'Integrated';
    case 'software':
      return 'Software';
    default:
      return 'GPU';
  }
}

export const PerformanceSettingsTab: React.FC<PerformanceSettingsTabProps> = ({
  settings: rawSettings,
  isDesktopTauri,
  onUpdateSettings,
  onShowToast,
}) => {
  // Defensive merge so hot-reloaded or legacy partial settings objects never have undefined fields
  const settings: AppSettings = useMemo(
    () => ({
      ...DEFAULT_APP_SETTINGS,
      ...rawSettings,
    }),
    [rawSettings]
  );

  const [hwInfo, setHwInfo] = useState<SystemHardwareInfo | null>(null);
  const [telemetry, setTelemetry] = useState<LiveMemoryTelemetry | null>(null);
  const [isRefreshingHw, setIsRefreshingHw] = useState(false);
  const [isPurging, setIsPurging] = useState(false);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [scratchPathInput, setScratchPathInput] = useState(settings.scratchDiskPath || '');
  const [scratchError, setScratchError] = useState<string | null>(null);
  const [isApplyingScratch, setIsApplyingScratch] = useState(false);

  useEffect(() => {
    setScratchPathInput(settings.scratchDiskPath || '');
  }, [settings.scratchDiskPath]);

  const refreshHardware = useCallback(async (force = false) => {
    setIsRefreshingHw(true);
    try {
      const info = await performanceManager.detectHardwareInfo(force);
      setHwInfo(info);
      return info;
    } finally {
      setIsRefreshingHw(false);
    }
  }, []);

  const refreshTelemetry = useCallback(async () => {
    const t = await performanceManager.getMemoryTelemetry();
    setTelemetry(t);
  }, []);

  useEffect(() => {
    void refreshHardware(false);
    void refreshTelemetry();
    const id = setInterval(() => {
      void refreshTelemetry();
    }, 1500);
    return () => clearInterval(id);
  }, [refreshHardware, refreshTelemetry]);

  const totalRamMb = hwInfo?.totalRamMb ?? 8192;
  const cpuCores = hwInfo?.cpuLogicalCores ?? 4;
  const memLimits = useMemo(() => computeAdobeMemoryLimits(totalRamMb), [totalRamMb]);

  const recommended = useMemo(
    () =>
      computeRecommendedSettings(
        hwInfo ?? {
          totalRamMb,
          cpuLogicalCores: cpuCores,
          gpus: [],
          activeWebGl: {
            available: true,
            renderer: 'WebGL2 GPU',
            vendor: 'Generic',
            glVersion: 'WebGL 2.0',
            maxTextureSize: 4096,
            maxArrayLayers: 256,
          },
        }
      ),
    [hwInfo, totalRamMb, cpuCores]
  );

  const currentBudgetMb = Math.max(
    memLimits.minMb,
    Math.min(memLimits.maxMb, settings.tileMemoryBudgetMb || 1024)
  );
  const currentPercent = memoryMbToPercent(currentBudgetMb, totalRamMb);
  const isAutoMode = Boolean(settings.autoOptimizePerformance);

  const patchManual = (patch: Partial<AppSettings>) => {
    onUpdateSettings({
      ...settings,
      ...patch,
      autoOptimizePerformance: false,
    });
  };

  const handleEnableAuto = async (showFeedback = true) => {
    const info = hwInfo ?? (await refreshHardware(false));
    const rec = computeRecommendedSettings(info);
    onUpdateSettings({
      ...settings,
      ...rec.settings,
      autoOptimizePerformance: true,
    });
    if (showFeedback) {
      onShowToast(`Automatic optimization enabled (${rec.summary})`);
    }
  };

  const handleToggleAuto = (checked: boolean) => {
    if (checked) {
      void handleEnableAuto(true);
    } else {
      onUpdateSettings({ ...settings, autoOptimizePerformance: false });
    }
  };

  const handleApplyPreset = (presetId: PerformancePresetId, label: string) => {
    const presetPatch = buildPerformancePreset(presetId, totalRamMb);
    onUpdateSettings({
      ...settings,
      ...presetPatch,
      autoOptimizePerformance: false,
    });
    onShowToast(`Switched to "${label}" mode`);
  };

  const handlePercentSliderChange = (nextPct: number) => {
    const nextMb = memoryPercentToMb(nextPct, totalRamMb);
    patchManual({
      memoryAllocationPercent: nextPct,
      tileMemoryBudgetMb: nextMb,
    });
  };

  const handleBudgetMbInputChange = (rawMb: number) => {
    if (!Number.isFinite(rawMb)) return;
    const clampedMb = Math.max(memLimits.minMb, Math.min(memLimits.maxMb, Math.round(rawMb)));
    const nextPct = memoryMbToPercent(clampedMb, totalRamMb);
    patchManual({
      tileMemoryBudgetMb: clampedMb,
      memoryAllocationPercent: nextPct,
    });
  };

  const handlePurge = async (scope: PurgeScope) => {
    if (isPurging) return;
    setIsPurging(true);
    try {
      const res = await performanceManager.purgeMemory(scope);
      await refreshTelemetry();
      const parts: string[] = [];
      if (res.freedTileMb > 0) parts.push(`${res.freedTileMb} MB tiles`);
      if (res.offloadedUndoSteps > 0) parts.push(`${res.offloadedUndoSteps} undo steps`);
      if (res.flushedGpuTextures) parts.push('GPU cache');
      if (res.freedScratchDiskMb > 0) parts.push(`${res.freedScratchDiskMb} MB scratch`);
      onShowToast(
        parts.length > 0 ? `Freed ${parts.join(', ')}` : 'Memory caches are already clean'
      );
    } finally {
      setIsPurging(false);
    }
  };

  const handleApplyScratchPath = async (nextPath: string) => {
    setScratchError(null);
    setIsApplyingScratch(true);
    try {
      const candidate: AppSettings = { ...settings, scratchDiskPath: nextPath.trim() };
      const result = await performanceManager.syncDesktopBackendConfig(candidate);
      if (!result.ok) {
        setScratchError(result.error || 'Unable to validate scratch disk directory');
        return;
      }
      if (result.info) {
        setHwInfo(result.info);
      }
      onUpdateSettings(candidate);
      onShowToast(
        nextPath.trim()
          ? 'Scratch disk location updated'
          : 'Scratch disk reset to system temporary folder'
      );
    } finally {
      setIsApplyingScratch(false);
    }
  };

  const handleRelaunchDesktop = async () => {
    if (!isDesktopTauri) return;
    try {
      await performanceManager.syncDesktopBackendConfig(settings);
      const { relaunch } = await import('@tauri-apps/plugin-process');
      await relaunch();
    } catch (err) {
      onShowToast(
        err instanceof Error ? `Restart failed: ${err.message}` : 'Please restart Ink Studio manually'
      );
    }
  };

  const needsRestart = performanceManager.needsRestartForDesktopGpuFlags(settings);
  const activeRendererName =
    telemetry?.compositor?.rendererName || hwInfo?.activeWebGl?.renderer || 'Detecting...';
  const activeRendererLower = activeRendererName.toLowerCase();
  const activePoolSpec =
    GPU_TEXTURE_POOL_CONFIGS[settings.gpuTexturePoolPreset] ?? GPU_TEXTURE_POOL_CONFIGS.high;
  const workerThreadsValue = Number.isFinite(settings.cpuWorkerThreads)
    ? settings.cpuWorkerThreads
    : 0;

  const barScaleMax = memLimits.totalRamMb;
  const allocatedPctOfTotal = Math.min(100, (currentBudgetMb / barScaleMax) * 100);
  const idealLeftPct = (memLimits.idealMinMb / barScaleMax) * 100;
  const idealWidthPct = Math.max(
    4,
    ((memLimits.idealMaxMb - memLimits.idealMinMb) / barScaleMax) * 100
  );
  const isOverIdeal = currentBudgetMb > memLimits.idealMaxMb;

  return (
    <div className="space-y-4" data-testid="performance-settings-tab">
      {/* 1. Automatic Optimization Hero & Quick Mode Selector */}
      <section className="rounded-md bg-[#161616] p-3.5 space-y-3 border border-white/[0.06]">
        <div className="flex items-start justify-between gap-3">
          <div className="flex items-start gap-2.5 min-w-0">
            <Sparkles className="w-4 h-4 text-[var(--accent)] mt-0.5 shrink-0" />
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <h3 className="text-xs font-medium text-[#e5e5e5]">Automatic Settings</h3>
                {isAutoMode && (
                  <span className="text-[10px] px-1.5 py-0.5 rounded bg-emerald-500/15 text-emerald-300 font-medium">
                    Active
                  </span>
                )}
              </div>
              <p className="text-[11px] text-[#8a8a8a] mt-0.5">
                {isAutoMode
                  ? `Automatically tuned for your hardware: ${recommended.summary}`
                  : 'Custom settings active. Turn on to let Ink Studio tune RAM, GPU, and caches automatically.'}
              </p>
            </div>
          </div>

          <label className="flex items-center gap-2 shrink-0 cursor-pointer pt-0.5">
            <input
              type="checkbox"
              aria-label="Automatic performance settings"
              checked={isAutoMode}
              onChange={(e) => handleToggleAuto(e.target.checked)}
            />
          </label>
        </div>

        {/* Quick Mode Bar */}
        <div className="grid grid-cols-4 gap-1.5">
          <button
            type="button"
            onClick={() => void handleEnableAuto(true)}
            className={`py-1.5 px-2 rounded text-[11px] transition-colors cursor-pointer ${
              isAutoMode
                ? 'bg-[#2c2c2c] text-[#e5e5e5] font-medium ring-1 ring-[var(--accent-border)]'
                : 'bg-[#202020] text-[#8a8a8a] hover:text-[#e5e5e5]'
            }`}
          >
            Auto
          </button>
          <button
            type="button"
            onClick={() => handleApplyPreset('maximum', 'Max Performance')}
            className={`py-1.5 px-2 rounded text-[11px] transition-colors cursor-pointer ${
              !isAutoMode && settings.renderBackend === 'webgl2' && settings.gpuPowerPreference === 'high-performance'
                ? 'bg-[#2c2c2c] text-[#e5e5e5] font-medium ring-1 ring-[var(--accent-border)]'
                : 'bg-[#202020] text-[#8a8a8a] hover:text-[#e5e5e5]'
            }`}
          >
            Performance
          </button>
          <button
            type="button"
            onClick={() => handleApplyPreset('battery', 'Battery Saver')}
            className={`py-1.5 px-2 rounded text-[11px] transition-colors cursor-pointer ${
              !isAutoMode && settings.gpuPowerPreference === 'low-power'
                ? 'bg-[#2c2c2c] text-[#e5e5e5] font-medium ring-1 ring-[var(--accent-border)]'
                : 'bg-[#202020] text-[#8a8a8a] hover:text-[#e5e5e5]'
            }`}
          >
            Battery
          </button>
          <button
            type="button"
            onClick={() => handleApplyPreset('compatibility', 'CPU Safe Mode')}
            className={`py-1.5 px-2 rounded text-[11px] transition-colors cursor-pointer ${
              !isAutoMode && settings.renderBackend === 'canvas2d'
                ? 'bg-[#2c2c2c] text-[#e5e5e5] font-medium ring-1 ring-[var(--accent-border)]'
                : 'bg-[#202020] text-[#8a8a8a] hover:text-[#e5e5e5]'
            }`}
          >
            CPU Safe
          </button>
        </div>

        {/* Compact System Strip */}
        <div className="flex items-center justify-between gap-2 pt-2 border-t border-white/[0.05] text-[10px] text-[#8a8a8a] font-mono">
          <div className="flex items-center gap-2 min-w-0 truncate">
            <span>{formatMb(totalRamMb)} RAM</span>
            <span>·</span>
            <span>{cpuCores} threads</span>
            <span>·</span>
            <span className="truncate text-[#cfcfcf]" title={activeRendererName}>
              {telemetry?.compositor?.backend === 'canvas2d'
                ? 'Canvas 2D (CPU)'
                : activeRendererName}
            </span>
          </div>
          <button
            type="button"
            onClick={() => {
              void refreshHardware(true);
              void refreshTelemetry();
            }}
            disabled={isRefreshingHw}
            className="p-1 rounded hover:bg-[#2c2c2c] text-[#8a8a8a] hover:text-[#e5e5e5] cursor-pointer shrink-0 disabled:opacity-50"
            title="Refresh hardware & memory telemetry"
          >
            <RefreshCw className={`w-3 h-3 ${isRefreshingHw ? 'animate-spin' : ''}`} />
          </button>
        </div>
      </section>

      {/* 2. Memory (RAM Limit) */}
      <section className="rounded-md bg-[#161616] p-3.5 space-y-3 border border-white/[0.05]">
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <MemoryStick className="w-3.5 h-3.5 text-[var(--accent)]" />
            <h3 className="text-xs font-medium text-[#e5e5e5]">Memory Usage (Max RAM)</h3>
          </div>
          <div className="flex items-center gap-1.5 shrink-0">
            <input
              type="number"
              aria-label="Maximum RAM in MB"
              min={memLimits.minMb}
              max={memLimits.maxMb}
              step={128}
              value={currentBudgetMb}
              onChange={(e) => handleBudgetMbInputChange(Number(e.target.value))}
              className="w-20 bg-[#202020] px-2 py-1 rounded font-mono text-xs text-right text-[#e5e5e5] border border-white/10"
            />
            <span className="text-[11px] font-mono text-[#8a8a8a]">MB ({currentPercent}%)</span>
          </div>
        </div>

        <div className="space-y-1.5">
          <div className="relative h-2 rounded-full bg-[#2a2a2a] overflow-hidden">
            <div
              className="absolute top-0 bottom-0 bg-emerald-500/20 border-x border-emerald-400/40"
              style={{ left: `${idealLeftPct}%`, width: `${idealWidthPct}%` }}
              title={`Ideal range: ${formatMb(memLimits.idealMinMb)} – ${formatMb(memLimits.idealMaxMb)}`}
            />
            <div
              className="h-full rounded-full transition-all duration-150"
              style={{
                width: `${allocatedPctOfTotal}%`,
                backgroundColor: isOverIdeal ? '#f59e0b' : 'var(--accent)',
              }}
            />
          </div>

          <input
            type="range"
            aria-label="RAM allocation percentage"
            min={20}
            max={85}
            step={1}
            value={currentPercent}
            onChange={(e) => handlePercentSliderChange(Number(e.target.value))}
            className="w-full"
          />

          <div className="flex items-center justify-between text-[10px] font-mono text-[#8a8a8a]">
            <span>{formatMb(memLimits.minMb)}</span>
            <span className="text-emerald-400/90">
              Ideal: {formatMb(memLimits.idealMinMb)} – {formatMb(memLimits.idealMaxMb)}
            </span>
            <span>{formatMb(memLimits.maxMb)}</span>
          </div>
        </div>

        {isOverIdeal && (
          <div className="flex items-center gap-1.5 text-[10px] text-amber-300 bg-amber-500/10 border border-amber-500/30 rounded px-2 py-1">
            <AlertTriangle className="w-3 h-3 shrink-0" />
            <span>Above 70% of system RAM may slow down other apps.</span>
          </div>
        )}

        {/* Compact Live Usage + Single Free Memory Action */}
        <div className="flex items-center justify-between gap-2 pt-2 border-t border-white/[0.05]">
          <div className="text-[10px] font-mono text-[#8a8a8a] truncate">
            {telemetry
              ? `In use: ${telemetry.activeTileMb} MB tiles · ${telemetry.ramUndoSteps} undo · ~${telemetry.compositor.estimatedVramMb} MB VRAM`
              : 'Measuring memory usage...'}
          </div>
          <button
            type="button"
            disabled={isPurging}
            onClick={() => void handlePurge('all')}
            className="flex items-center gap-1 px-2.5 py-1 rounded bg-[#2c2c2c] hover:bg-[#383838] text-[10px] text-[#e5e5e5] font-medium cursor-pointer shrink-0 disabled:opacity-50"
            title="Offload inactive tiles & undo states and flush GPU texture cache"
          >
            <Trash2 className="w-3 h-3 text-[var(--accent)]" />
            <span>Free Memory</span>
          </button>
        </div>
      </section>

      {/* 3. Graphics & Rendering */}
      <section className="rounded-md bg-[#161616] p-3.5 space-y-3 border border-white/[0.05]">
        <div className="flex items-center gap-2">
          <Monitor className="w-3.5 h-3.5 text-[var(--accent)]" />
          <h3 className="text-xs font-medium text-[#e5e5e5]">Graphics & Rendering</h3>
        </div>

        <div className="grid grid-cols-3 gap-1.5">
          {(
            [
              { id: 'auto', label: 'Auto (GPU)' },
              { id: 'webgl2', label: 'WebGL2 GPU' },
              { id: 'canvas2d', label: 'Canvas 2D (CPU)' },
            ] as Array<{ id: RenderBackend; label: string }>
          ).map((opt) => {
            const selected = settings.renderBackend === opt.id;
            return (
              <button
                key={opt.id}
                type="button"
                onClick={() => patchManual({ renderBackend: opt.id })}
                className={`py-1.5 px-2 rounded text-[11px] transition-colors cursor-pointer ${
                  selected
                    ? 'bg-[#2c2c2c] text-[#e5e5e5] font-medium ring-1 ring-[var(--accent-border)]'
                    : 'bg-[#202020] text-[#8a8a8a] hover:text-[#e5e5e5]'
                }`}
              >
                {opt.label}
              </button>
            );
          })}
        </div>

        <div className="flex items-center justify-between gap-3 pt-2 border-t border-white/[0.05]">
          <span className="text-xs text-[#e5e5e5]">Graphics Card</span>
          <select
            aria-label="Graphics Card Preference"
            disabled={settings.renderBackend === 'canvas2d'}
            value={settings.gpuPowerPreference}
            onChange={(e) =>
              patchManual({ gpuPowerPreference: e.target.value as GpuPowerPreference })
            }
            className="bg-[#202020] text-[#e5e5e5] text-xs px-2.5 py-1.5 rounded border border-white/10 cursor-pointer disabled:opacity-40"
          >
            <option value="high-performance">High-Performance (Dedicated)</option>
            <option value="low-power">Power-Saving (Integrated)</option>
            <option value="default">System Default</option>
          </select>
        </div>

        {/* Detected GPUs (compact rows) */}
        {hwInfo && Array.isArray(hwInfo.gpus) && hwInfo.gpus.length > 0 && (
          <div className="space-y-1 pt-2 border-t border-white/[0.05]">
            {hwInfo.gpus.map((gpu) => {
              const gpuName = gpu.name || 'Graphics Adapter';
              const isActive =
                telemetry?.compositor?.backend === 'webgl2' &&
                gpuName.length > 0 &&
                activeRendererLower.includes(gpuName.toLowerCase().slice(0, 14));
              return (
                <div
                  key={gpu.id}
                  className={`flex items-center justify-between gap-2 px-2.5 py-1.5 rounded text-[11px] ${
                    isActive ? 'bg-[#252525] ring-1 ring-[var(--accent-border)]' : 'bg-[#202020]'
                  }`}
                >
                  <div className="flex items-center gap-1.5 min-w-0">
                    <span className="text-[#e5e5e5] truncate">{gpuName}</span>
                    <span className="text-[9px] px-1.5 py-0.5 rounded bg-[#161616] text-[#8a8a8a] shrink-0">
                      {formatGpuKindLabel(gpu.kind)}
                      {gpu.vramMb > 0 ? ` · ${formatMb(gpu.vramMb)}` : ''}
                    </span>
                  </div>
                  {isActive && (
                    <span className="flex items-center gap-1 text-[10px] font-medium text-emerald-400 shrink-0">
                      <Check className="w-3 h-3" />
                      Active
                    </span>
                  )}
                </div>
              );
            })}
          </div>
        )}

        {needsRestart && (
          <div className="flex items-center justify-between gap-2 p-2 rounded bg-amber-500/10 border border-amber-500/35 text-[11px]">
            <span className="text-amber-200">
              Restart Ink Studio to apply the OS-level GPU preference.
            </span>
            <button
              type="button"
              onClick={() => void handleRelaunchDesktop()}
              className="flex items-center gap-1 px-2.5 py-1 rounded bg-amber-500 text-black font-medium shrink-0 cursor-pointer hover:opacity-90"
            >
              <RotateCw className="w-3 h-3" />
              <span>Restart</span>
            </button>
          </div>
        )}
      </section>

      {/* 4. Collapsible Advanced Settings */}
      <section className="rounded-md bg-[#161616] border border-white/[0.05] overflow-hidden">
        <button
          type="button"
          onClick={() => setShowAdvanced((v) => !v)}
          aria-expanded={showAdvanced}
          className="w-full px-3.5 py-2.5 flex items-center justify-between text-left hover:bg-[#1e1e1e] transition-colors cursor-pointer"
        >
          <div className="flex items-center gap-2">
            <SlidersHorizontal className="w-3.5 h-3.5 text-[#8a8a8a]" />
            <div>
              <span className="text-xs font-medium text-[#e5e5e5]">Advanced Settings</span>
              <span className="ml-2 text-[10px] text-[#8a8a8a]">
                VRAM Cache, HiDPI, Undo, CPU Threads & Scratch Disk
              </span>
            </div>
          </div>
          {showAdvanced ? (
            <ChevronDown className="w-3.5 h-3.5 text-[#8a8a8a]" />
          ) : (
            <ChevronRight className="w-3.5 h-3.5 text-[#8a8a8a]" />
          )}
        </button>

        {showAdvanced && (
          <div className="px-3.5 pb-3.5 pt-2 border-t border-white/[0.06] space-y-4">
            {/* GPU & Display Tuning */}
            <div className="space-y-2.5">
              <div className="text-[10px] uppercase tracking-wider text-[#8a8a8a] font-medium">
                GPU & Display
              </div>

              <div className="space-y-1.5">
                <div className="flex items-center justify-between">
                  <span className="text-xs text-[#e5e5e5]">GPU Tile Cache (VRAM)</span>
                  <span className="font-mono text-[10px] text-[#8a8a8a]">
                    {activePoolSpec.arrayLayers} slices
                  </span>
                </div>
                <div className="grid grid-cols-4 gap-1.5">
                  {(['low', 'balanced', 'high', 'ultra'] as GpuTexturePoolPreset[]).map((preset) => {
                    const spec = GPU_TEXTURE_POOL_CONFIGS[preset];
                    const selected = settings.gpuTexturePoolPreset === preset;
                    return (
                      <button
                        key={preset}
                        type="button"
                        disabled={settings.renderBackend === 'canvas2d'}
                        onClick={() => patchManual({ gpuTexturePoolPreset: preset })}
                        className={`py-1 px-1.5 rounded text-[10px] transition-colors cursor-pointer disabled:opacity-40 ${
                          selected
                            ? 'bg-[#2c2c2c] text-[#e5e5e5] font-medium ring-1 ring-[var(--accent-border)]'
                            : 'bg-[#202020] text-[#8a8a8a] hover:text-[#e5e5e5]'
                        }`}
                      >
                        {spec.label}
                      </button>
                    );
                  })}
                </div>
              </div>

              <div className="flex items-center justify-between gap-3">
                <span className="text-xs text-[#e5e5e5]">Viewport Resolution (HiDPI)</span>
                <select
                  aria-label="Viewport Resolution Scaling"
                  value={settings.viewportResolutionScale}
                  onChange={(e) =>
                    patchManual({
                      viewportResolutionScale: e.target.value as ViewportResolutionScale,
                    })
                  }
                  className="bg-[#202020] text-[#e5e5e5] text-xs px-2 py-1 rounded border border-white/10 cursor-pointer"
                >
                  <option value="native">Native Display DPI</option>
                  <option value="capped-2x">Capped 2× (Recommended)</option>
                  <option value="1x">Standard 1× (High FPS)</option>
                  <option value="0.75x">Performance 0.75×</option>
                </select>
              </div>

              <div className="flex items-center justify-between gap-3">
                <span className="text-xs text-[#e5e5e5]">Zoom Texture Filtering</span>
                <select
                  aria-label="Canvas Texture Filtering"
                  value={settings.canvasFilteringQuality}
                  onChange={(e) =>
                    patchManual({
                      canvasFilteringQuality: e.target.value as CanvasFilteringQuality,
                    })
                  }
                  className="bg-[#202020] text-[#e5e5e5] text-xs px-2 py-1 rounded border border-white/10 cursor-pointer"
                >
                  <option value="auto">Auto (Crisp ≥200%)</option>
                  <option value="smooth">Always Smooth</option>
                  <option value="pixelated">Always Sharp (Nearest)</option>
                </select>
              </div>

              {isDesktopTauri && (
                <div className="flex items-center justify-between gap-3">
                  <span className="text-xs text-[#e5e5e5]">Desktop Graphics API (ANGLE)</span>
                  <select
                    aria-label="Desktop Graphics API"
                    value={settings.desktopGraphicsApi}
                    onChange={(e) =>
                      patchManual({ desktopGraphicsApi: e.target.value as DesktopGraphicsApi })
                    }
                    className="bg-[#202020] text-[#e5e5e5] text-xs px-2 py-1 rounded border border-white/10 cursor-pointer"
                  >
                    <option value="auto">Auto (OS Default)</option>
                    <option value="d3d11">Direct3D 11</option>
                    <option value="vulkan">Vulkan</option>
                    <option value="gl">OpenGL</option>
                    <option value="warp">WARP (Software)</option>
                  </select>
                </div>
              )}

              <label className="flex items-center justify-between py-0.5 cursor-pointer">
                <span className="text-xs text-[#e5e5e5]">GPU Brush Acceleration</span>
                <input
                  type="checkbox"
                  disabled={settings.renderBackend === 'canvas2d'}
                  checked={settings.gpuBrushAcceleration}
                  onChange={(e) => patchManual({ gpuBrushAcceleration: e.target.checked })}
                />
              </label>

              <label className="flex items-center justify-between py-0.5 cursor-pointer">
                <span className="text-xs text-[#e5e5e5]">Baked Layer Stack Cache</span>
                <input
                  type="checkbox"
                  disabled={settings.renderBackend === 'canvas2d'}
                  checked={settings.layerStackCaching}
                  onChange={(e) => patchManual({ layerStackCaching: e.target.checked })}
                />
              </label>
            </div>

            {/* Undo & Multi-Tab Memory */}
            <div className="space-y-2.5 pt-3 border-t border-white/[0.06]">
              <div className="text-[10px] uppercase tracking-wider text-[#8a8a8a] font-medium">
                Undo & Multi-Document Memory
              </div>

              <div className="space-y-1">
                <div className="flex items-center justify-between">
                  <span className="text-xs text-[#e5e5e5]">Max History States</span>
                  <span className="font-mono text-[11px] text-[#e5e5e5]">
                    {settings.maxHistorySteps}
                  </span>
                </div>
                <div className="grid grid-cols-6 gap-1">
                  {[25, 50, 75, 100, 150, 200].map((steps) => (
                    <button
                      key={steps}
                      type="button"
                      onClick={() => patchManual({ maxHistorySteps: steps })}
                      className={`py-1 rounded font-mono text-[10px] cursor-pointer ${
                        settings.maxHistorySteps === steps
                          ? 'bg-[#2c2c2c] text-[#e5e5e5] font-medium ring-1 ring-[var(--accent-border)]'
                          : 'bg-[#202020] text-[#8a8a8a] hover:text-[#e5e5e5]'
                      }`}
                    >
                      {steps}
                    </button>
                  ))}
                </div>
              </div>

              <div className="space-y-1">
                <div className="flex items-center justify-between">
                  <span className="text-xs text-[#e5e5e5]">In-RAM Undo Steps</span>
                  <span className="font-mono text-[11px] text-[#e5e5e5]">
                    {settings.undoRamSteps} steps
                  </span>
                </div>
                <input
                  type="range"
                  aria-label="In-RAM undo steps"
                  min={4}
                  max={50}
                  step={1}
                  value={settings.undoRamSteps}
                  onChange={(e) => patchManual({ undoRamSteps: Number(e.target.value) })}
                  className="w-full"
                />
              </div>

              <label className="flex items-center justify-between py-0.5 cursor-pointer">
                <span className="text-xs text-[#e5e5e5]">Offload Inactive Document Tabs</span>
                <input
                  type="checkbox"
                  checked={settings.offloadInactiveTabs}
                  onChange={(e) => patchManual({ offloadInactiveTabs: e.target.checked })}
                />
              </label>

              <div className="flex items-center justify-between gap-2 pt-1">
                <span className="text-[10px] text-[#8a8a8a]">Granular Cache Purge</span>
                <div className="flex items-center gap-1.5">
                  <button
                    type="button"
                    disabled={isPurging}
                    onClick={() => void handlePurge('tiles')}
                    className="px-2 py-1 rounded bg-[#202020] hover:bg-[#2c2c2c] text-[10px] text-[#e5e5e5] cursor-pointer disabled:opacity-50"
                  >
                    Tiles
                  </button>
                  <button
                    type="button"
                    disabled={isPurging}
                    onClick={() => void handlePurge('undo')}
                    className="px-2 py-1 rounded bg-[#202020] hover:bg-[#2c2c2c] text-[10px] text-[#e5e5e5] cursor-pointer disabled:opacity-50"
                  >
                    Undo
                  </button>
                  <button
                    type="button"
                    disabled={isPurging}
                    onClick={() => void handlePurge('gpu')}
                    className="px-2 py-1 rounded bg-[#202020] hover:bg-[#2c2c2c] text-[10px] text-[#e5e5e5] cursor-pointer disabled:opacity-50"
                  >
                    GPU
                  </button>
                </div>
              </div>
            </div>

            {/* 3D & CPU Threading */}
            <div className="space-y-2.5 pt-3 border-t border-white/[0.06]">
              <div className="text-[10px] uppercase tracking-wider text-[#8a8a8a] font-medium">
                3D & CPU
              </div>

              <div className="flex items-center justify-between gap-3">
                <span className="text-xs text-[#e5e5e5]">3D Preview Resolution</span>
                <div className="flex items-center gap-2">
                  <select
                    aria-label="3D Preview Resolution Cap"
                    value={settings.preview3DMaxResolution}
                    onChange={(e) =>
                      patchManual({
                        preview3DMaxResolution: Number(e.target.value) as Preview3DMaxResolution,
                      })
                    }
                    className="bg-[#202020] text-[#e5e5e5] text-xs px-2 py-1 rounded border border-white/10 cursor-pointer"
                  >
                    <option value={1024}>1024 px</option>
                    <option value={1920}>1920 px</option>
                    <option value={2560}>2560 px</option>
                  </select>
                  <label className="flex items-center gap-1 text-[11px] text-[#e5e5e5] cursor-pointer">
                    <input
                      type="checkbox"
                      checked={settings.preview3DAntialias}
                      onChange={(e) => patchManual({ preview3DAntialias: e.target.checked })}
                    />
                    <span>AA</span>
                  </label>
                </div>
              </div>

              {isDesktopTauri && (
                <>
                  <div className="space-y-1">
                    <div className="flex items-center justify-between">
                      <span className="text-xs text-[#e5e5e5]">CPU Worker Threads</span>
                      <span className="font-mono text-[11px] text-[#e5e5e5]">
                        {workerThreadsValue === 0
                          ? `Auto (${cpuCores})`
                          : `${workerThreadsValue} / ${cpuCores}`}
                      </span>
                    </div>
                    <input
                      type="range"
                      aria-label="CPU worker threads"
                      min={0}
                      max={cpuCores}
                      step={1}
                      value={Math.min(workerThreadsValue, cpuCores)}
                      onChange={(e) => patchManual({ cpuWorkerThreads: Number(e.target.value) })}
                      className="w-full"
                    />
                  </div>

                  <label className="flex items-center justify-between py-0.5 cursor-pointer">
                    <span className="text-xs text-[#e5e5e5]">Native Rust Acceleration</span>
                    <input
                      type="checkbox"
                      checked={settings.useNativeRustAcceleration}
                      onChange={(e) =>
                        patchManual({ useNativeRustAcceleration: e.target.checked })
                      }
                    />
                  </label>
                </>
              )}
            </div>

            {/* Scratch Disk */}
            <div className="space-y-2 pt-3 border-t border-white/[0.06]">
              <div className="flex items-center justify-between">
                <span className="text-[10px] uppercase tracking-wider text-[#8a8a8a] font-medium flex items-center gap-1.5">
                  <HardDrive className="w-3 h-3" />
                  <span>Scratch Disk</span>
                </span>
                <span
                  className="font-mono text-[10px] text-[#8a8a8a] truncate max-w-[260px]"
                  title={hwInfo?.scratchDiskPath}
                >
                  {hwInfo?.scratchDiskPath || 'System Temp'}
                  {isDesktopTauri && hwInfo && hwInfo.scratchDiskFreeMb > 0
                    ? ` · ${formatMb(hwInfo.scratchDiskFreeMb)} free`
                    : ''}
                </span>
              </div>

              {isDesktopTauri && (
                <>
                  <div className="flex items-center gap-1.5">
                    <input
                      type="text"
                      value={scratchPathInput}
                      onChange={(e) => {
                        setScratchPathInput(e.target.value);
                        setScratchError(null);
                      }}
                      placeholder="Custom folder (optional, e.g. secondary SSD)"
                      className="flex-1 bg-[#202020] px-2.5 py-1 rounded font-mono text-[11px] text-[#e5e5e5] placeholder-[#8a8a8a]/50 border border-white/10"
                    />
                    <button
                      type="button"
                      disabled={isApplyingScratch}
                      onClick={() => void handleApplyScratchPath(scratchPathInput)}
                      className="px-2.5 py-1 rounded bg-[#2c2c2c] hover:bg-[#383838] text-[11px] text-[#e5e5e5] font-medium cursor-pointer shrink-0 disabled:opacity-50"
                    >
                      Apply
                    </button>
                    {settings.scratchDiskPath && (
                      <button
                        type="button"
                        disabled={isApplyingScratch}
                        onClick={() => {
                          setScratchPathInput('');
                          void handleApplyScratchPath('');
                        }}
                        className="px-2 py-1 rounded bg-[#202020] hover:bg-[#2c2c2c] text-[11px] text-[#8a8a8a] hover:text-[#e5e5e5] cursor-pointer shrink-0"
                      >
                        Reset
                      </button>
                    )}
                  </div>
                  {scratchError && <div className="text-[10px] text-red-400">{scratchError}</div>}

                  <div className="flex items-center justify-between gap-3">
                    <span className="text-xs text-[#e5e5e5]">Scratch Compression</span>
                    <select
                      aria-label="Scratch Disk Compression"
                      value={settings.scratchDiskCompression}
                      onChange={(e) =>
                        patchManual({
                          scratchDiskCompression: e.target.value as ScratchDiskCompression,
                        })
                      }
                      className="bg-[#202020] text-[#e5e5e5] text-xs px-2 py-1 rounded border border-white/10 cursor-pointer"
                    >
                      <option value="lz4">LZ4 Fast (Recommended)</option>
                      <option value="none">Uncompressed</option>
                    </select>
                  </div>
                </>
              )}
            </div>
          </div>
        )}
      </section>
    </div>
  );
};
