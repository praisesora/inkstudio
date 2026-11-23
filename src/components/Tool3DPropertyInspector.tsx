import React, { useState, useEffect } from 'react';
import {
  Box,
  Upload,
  Magnet,
  RotateCcw,
  Lock,
  Unlock,
  Layers,
  CopyPlus,
  Eye,
  EyeOff,
  Compass,
} from 'lucide-react';
import {
  Camera3DPreset,
  Gizmo3DMode,
  Shading3DMode,
  TOOL_3D_BEHAVIOR_RULES,
  Tool3DMode,
} from '../utils/tool3DRules';
import { PosePresetName } from '../utils/mannequin3D';
import { LightSourceWidget } from './LightSourceWidget';
import {
  scene3DBridge,
  selectHasOpenDocument,
  store3DActions,
  uiStoreActions,
  use3DStore,
  useDocumentStore,
  useUiStore,
} from '../stores';

type Inspector3DTab = 'transform' | 'light' | 'scene' | 'pose';

interface NumericAxisRowProps {
  label: string;
  values: [number, number, number];
  step: number;
  suffix?: string;
  onChangeAxis: (axisIdx: 0 | 1 | 2, value: number) => void;
}

const AXIS_LABELS = ['X', 'Y', 'Z'] as const;
const AXIS_COLORS = ['text-red-400', 'text-emerald-400', 'text-sky-400'] as const;

const NumericAxisRow: React.FC<NumericAxisRowProps> = ({
  label,
  values,
  step,
  suffix = '',
  onChangeAxis,
}) => (
  <div className="space-y-1">
    <div className="flex items-center justify-between text-[10px] text-[#8a8a8a]">
      <span>{label}</span>
      {suffix && <span className="font-mono text-[9px] text-[#666]">{suffix}</span>}
    </div>
    <div className="grid grid-cols-3 gap-1">
      {([0, 1, 2] as const).map((idx) => (
        <label
          key={AXIS_LABELS[idx]}
          className="flex items-center bg-[#161616] border border-white/[0.06] rounded px-1 py-0.5 gap-0.5 focus-within:border-[var(--accent)]"
        >
          <span className={`text-[9px] font-mono font-semibold ${AXIS_COLORS[idx]}`}>
            {AXIS_LABELS[idx]}
          </span>
          <input
            type="number"
            step={step}
            value={Number.isFinite(values[idx]) ? values[idx] : 0}
            onChange={(e) => {
              const parsed = parseFloat(e.target.value);
              if (Number.isFinite(parsed)) {
                onChangeAxis(idx, parsed);
              }
            }}
            className="w-full min-w-0 bg-transparent text-[10px] font-mono text-[#e5e5e5] outline-none text-right"
          />
        </label>
      ))}
    </div>
  </div>
);

export const Tool3DPropertyInspector: React.FC = () => {
  const hasOpenDocument = useDocumentStore(selectHasOpenDocument);
  const is3DLayerOpen = useUiStore((s) => s.is3DLayerOpen);

  const activeMode = use3DStore((s) => s.activeMode);
  const gizmoMode = use3DStore((s) => s.gizmoMode);
  const gizmoSpace = use3DStore((s) => s.gizmoSpace);
  const snapEnabled = use3DStore((s) => s.snapEnabled);
  const isReferenceVisible = use3DStore((s) => s.isReferenceVisible);
  const loadedModelName = use3DStore((s) => s.loadedModelName);
  const isMannequinActive = use3DStore((s) => s.isMannequinActive);
  const activeIKHandle = use3DStore((s) => s.activeIKHandle);
  const showIKHandles = use3DStore((s) => s.showIKHandles);
  const isBaking = use3DStore((s) => s.isBaking);
  const modelTransform = use3DStore((s) => s.modelTransform);
  const lighting = use3DStore((s) => s.lighting);
  const shadingMode = use3DStore((s) => s.shadingMode);
  const materialRoughness = use3DStore((s) => s.materialRoughness);
  const toonOutline = use3DStore((s) => s.toonOutline);
  const opacity = use3DStore((s) => s.opacity);
  const showGrid = use3DStore((s) => s.showGrid);
  const perspective = use3DStore((s) => s.perspective);
  const fov = use3DStore((s) => s.fov);
  const syncCameraPerspective = use3DStore((s) => s.syncCameraPerspective);

  const [activeTab, setActiveTab] = useState<Inspector3DTab>('transform');
  const [showRules, setShowRules] = useState(false);

  // If mannequin becomes inactive while on Pose tab, return cleanly to Edit tab
  useEffect(() => {
    if (!isMannequinActive && activeTab === 'pose') {
      setActiveTab('transform');
    }
  }, [isMannequinActive, activeTab]);

  const hasModel = Boolean(loadedModelName);

  if (!hasOpenDocument) {
    return (
      <div className="p-2.5 space-y-2 overflow-y-auto flex-1">
        <div className="text-[11px] font-medium text-[#e5e5e5]">3D Studio Tool</div>
        <p className="text-[10px] text-[#8a8a8a] leading-relaxed">
          Open or create a canvas document to use the 3D reference stage.
        </p>
      </div>
    );
  }

  if (!is3DLayerOpen) {
    return (
      <div className="p-2.5 space-y-2.5 overflow-y-auto flex-1">
        <div className="text-[11px] font-medium text-[#e5e5e5]">3D Studio Tool</div>
        <p className="text-[10px] text-[#8a8a8a] leading-relaxed">
          Open the 3D reference stage to position, light, and extract lineart from imported .glb / .gltf / .obj models directly on the canvas.
        </p>
        <button
          type="button"
          onClick={() => uiStoreActions.set3DLayerOpen(true)}
          className="w-full py-1.5 rounded bg-[var(--accent)] text-[var(--accent-contrast)] text-[11px] font-medium hover:opacity-90 cursor-pointer"
        >
          Open 3D Stage
        </button>
      </div>
    );
  }

  const updatePosAxis = (idx: 0 | 1 | 2, val: number) => {
    const nextPos: [number, number, number] = [...modelTransform.position];
    nextPos[idx] = val;
    scene3DBridge.applyNumericTransform?.({ ...modelTransform, position: nextPos });
  };

  const updateRotAxis = (idx: 0 | 1 | 2, val: number) => {
    const nextRot: [number, number, number] = [...modelTransform.rotation];
    nextRot[idx] = val;
    scene3DBridge.applyNumericTransform?.({ ...modelTransform, rotation: nextRot });
  };

  const updateScaleAxis = (idx: 0 | 1 | 2, pctVal: number) => {
    const mult = Math.max(0.05, Math.min(10, pctVal / 100));
    const nextScale: [number, number, number] = modelTransform.uniformScale
      ? [mult, mult, mult]
      : ([
          idx === 0 ? mult : modelTransform.scale[0],
          idx === 1 ? mult : modelTransform.scale[1],
          idx === 2 ? mult : modelTransform.scale[2],
        ] as [number, number, number]);
    scene3DBridge.applyNumericTransform?.({ ...modelTransform, scale: nextScale });
  };

  const uniformScalePct = Math.round(modelTransform.scale[0] * 100);
  const tabs: Array<[Inspector3DTab, string]> = [
    ['transform', 'Edit'],
    ['light', 'Light'],
    ['scene', 'View'],
    ...(isMannequinActive ? ([['pose', 'Pose']] as Array<[Inspector3DTab, string]>) : []),
  ];

  return (
    <div className="flex flex-col flex-1 min-h-0 overflow-hidden text-[#e5e5e5]">
      {/* Header + Quick Model Source Actions */}
      <div className="px-2 pt-2 pb-1.5 border-b border-white/[0.06] space-y-1.5 shrink-0">
        <div className="flex items-center justify-between gap-1">
          <div className="flex items-center gap-1 min-w-0">
            <Box className="w-3.5 h-3.5 text-[var(--accent)] shrink-0" />
            <span className="text-[11px] font-medium truncate">
              {loadedModelName || '3D Studio'}
            </span>
          </div>
          <button
            type="button"
            onClick={() => store3DActions.toggleReferenceVisible()}
            title={isReferenceVisible ? 'Hide 3D Reference' : 'Show 3D Reference'}
            className="p-1 rounded text-[#8a8a8a] hover:text-[#e5e5e5] hover:bg-[#2c2c2c] cursor-pointer shrink-0"
          >
            {isReferenceVisible ? <Eye className="w-3 h-3" /> : <EyeOff className="w-3 h-3" />}
          </button>
        </div>

        <button
          type="button"
          onClick={() => scene3DBridge.triggerFilePicker?.()}
          className="w-full flex items-center justify-center gap-1.5 py-1 rounded bg-[#161616] hover:bg-[#2c2c2c] border border-white/[0.06] text-[10px] text-[#cccccc] hover:text-[#e5e5e5] cursor-pointer"
        >
          <Upload className="w-3 h-3 text-[var(--accent)]" />
          <span>Import 3D Model (.glb / .obj)</span>
        </button>

        {/* Inspector Section Tabs */}
        <div
          className={`grid gap-0.5 bg-[#161616] p-0.5 rounded ${
            tabs.length === 4 ? 'grid-cols-4' : 'grid-cols-3'
          }`}
        >
          {tabs.map(([tabId, label]) => (
            <button
              key={tabId}
              type="button"
              onClick={() => setActiveTab(tabId)}
              className={`py-1 rounded text-[10px] transition-colors cursor-pointer ${
                activeTab === tabId
                  ? 'bg-[#2c2c2c] text-[#e5e5e5] font-medium'
                  : 'text-[#8a8a8a] hover:text-[#e5e5e5]'
              }`}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      {/* Scrollable Inspector Body */}
      <div className="flex-1 overflow-y-auto p-2 space-y-3">
        {activeTab === 'transform' && (
          <>
            {/* Canvas Drag Sub-Mode */}
            <div className="space-y-1">
              <span className="text-[10px] uppercase tracking-wider text-[#6e6e6e]">
                Canvas Tool Mode
              </span>
              <div className="grid grid-cols-2 gap-1">
                {(
                  [
                    ['smart', 'Smart (Auto)'],
                    ['model-rotate', 'Free Rotate'],
                    ['model-rotate-yaw', 'Turn Y-Axis'],
                    ['model-rotate-roll', 'Screen Roll'],
                    ['model-move', 'Move Plane'],
                    ['model-plane-move', 'Slide Floor'],
                    ['model-scale', 'Scale Drag'],
                    ['camera-orbit', 'Cam Orbit'],
                  ] as Array<[Tool3DMode, string]>
                ).map(([mode, label]) => (
                  <button
                    key={mode}
                    type="button"
                    onClick={() => store3DActions.setActiveMode(mode)}
                    className={`py-1 px-1.5 rounded text-[10px] text-left truncate transition-colors cursor-pointer ${
                      activeMode === mode
                        ? 'bg-[var(--accent)] text-[var(--accent-contrast)] font-medium'
                        : 'bg-[#161616] text-[#8a8a8a] hover:text-[#e5e5e5] hover:bg-[#2c2c2c]'
                    }`}
                  >
                    {label}
                  </button>
                ))}
              </div>
            </div>

            {/* On-Canvas 3D Manipulator Gizmo */}
            <div className="space-y-1.5 pt-1 border-t border-white/[0.06]">
              <div className="flex items-center justify-between">
                <span className="text-[10px] uppercase tracking-wider text-[#6e6e6e]">
                  On-Canvas Gizmo
                </span>
                <button
                  type="button"
                  onClick={() =>
                    store3DActions.setGizmoSpace(gizmoSpace === 'local' ? 'world' : 'local')
                  }
                  title="Toggle Local vs World Gizmo Axes"
                  className="text-[9px] font-mono px-1.5 py-0.5 rounded bg-[#161616] hover:bg-[#2c2c2c] text-[#cccccc] cursor-pointer"
                >
                  {gizmoSpace === 'local' ? 'Local' : 'World'}
                </button>
              </div>
              <div className="grid grid-cols-4 gap-0.5 bg-[#161616] p-0.5 rounded">
                {(
                  [
                    ['rotate', 'Rot'],
                    ['translate', 'Pos'],
                    ['scale', 'Scl'],
                    ['none', 'Off'],
                  ] as Array<[Gizmo3DMode, string]>
                ).map(([gm, lbl]) => (
                  <button
                    key={gm}
                    type="button"
                    onClick={() => store3DActions.setGizmoMode(gm)}
                    className={`py-1 rounded text-[10px] cursor-pointer ${
                      gizmoMode === gm
                        ? 'bg-[#2c2c2c] text-[var(--accent)] font-medium'
                        : 'text-[#8a8a8a] hover:text-[#e5e5e5]'
                    }`}
                  >
                    {lbl}
                  </button>
                ))}
              </div>
              <label className="flex items-center justify-between text-[10px] text-[#8a8a8a] cursor-pointer">
                <span>Snap (15° / 10% · Shift)</span>
                <input
                  type="checkbox"
                  checked={snapEnabled}
                  onChange={(e) => store3DActions.setSnapEnabled(e.target.checked)}
                />
              </label>
            </div>

            {/* Live Numeric Position / Rotation / Scale */}
            <div className="space-y-2.5 pt-1 border-t border-white/[0.06]">
              <NumericAxisRow
                label="Position"
                values={modelTransform.position}
                step={0.1}
                suffix="units"
                onChangeAxis={updatePosAxis}
              />

              <NumericAxisRow
                label="Rotation"
                values={modelTransform.rotation}
                step={5}
                suffix="deg"
                onChangeAxis={updateRotAxis}
              />

              {/* Scale with Uniform Lock */}
              <div className="space-y-1">
                <div className="flex items-center justify-between text-[10px]">
                  <span className="text-[#8a8a8a]">Scale</span>
                  <div className="flex items-center gap-1">
                    <span className="font-mono text-[#e5e5e5]">{uniformScalePct}%</span>
                    <button
                      type="button"
                      onClick={() =>
                        store3DActions.setModelTransform({
                          uniformScale: !modelTransform.uniformScale,
                        })
                      }
                      title={
                        modelTransform.uniformScale
                          ? 'Uniform scale locked (click to unlock X/Y/Z)'
                          : 'Non-uniform X/Y/Z scale (click to lock)'
                      }
                      className="p-0.5 rounded bg-[#161616] hover:bg-[#2c2c2c] text-[#cccccc] cursor-pointer"
                    >
                      {modelTransform.uniformScale ? (
                        <Lock className="w-2.5 h-2.5 text-[var(--accent)]" />
                      ) : (
                        <Unlock className="w-2.5 h-2.5 text-[#8a8a8a]" />
                      )}
                    </button>
                  </div>
                </div>
                {modelTransform.uniformScale ? (
                  <input
                    type="range"
                    min={15}
                    max={300}
                    step={5}
                    value={Math.max(15, Math.min(300, uniformScalePct))}
                    onChange={(e) => updateScaleAxis(0, parseFloat(e.target.value))}
                    className="w-full"
                  />
                ) : (
                  <NumericAxisRow
                    label=""
                    values={[
                      Math.round(modelTransform.scale[0] * 100),
                      Math.round(modelTransform.scale[1] * 100),
                      Math.round(modelTransform.scale[2] * 100),
                    ]}
                    step={5}
                    suffix="%"
                    onChangeAxis={updateScaleAxis}
                  />
                )}
              </div>
            </div>

            {/* Quick Turn & Utility Buttons */}
            <div className="space-y-1.5 pt-1 border-t border-white/[0.06]">
              <div className="grid grid-cols-3 gap-1">
                {([-90, 90, 180] as const).map((deg) => (
                  <button
                    key={deg}
                    type="button"
                    disabled={!hasModel}
                    onClick={() => scene3DBridge.rotateModelYaw?.(deg)}
                    className="py-1 rounded bg-[#161616] hover:bg-[#2c2c2c] border border-white/[0.06] text-[10px] font-mono text-[#e5e5e5] disabled:opacity-40 cursor-pointer"
                  >
                    {deg > 0 ? `+${deg}°` : `${deg}°`}
                  </button>
                ))}
              </div>
              <div className="grid grid-cols-2 gap-1">
                <button
                  type="button"
                  disabled={!hasModel}
                  onClick={() => scene3DBridge.snapToGround?.()}
                  className="flex items-center justify-center gap-1 py-1 rounded bg-[#161616] hover:bg-[#2c2c2c] border border-white/[0.06] text-[10px] text-[#e5e5e5] disabled:opacity-40 cursor-pointer"
                >
                  <Magnet className="w-3 h-3 text-[var(--accent)]" />
                  <span>Snap Floor</span>
                </button>
                <button
                  type="button"
                  disabled={!hasModel}
                  onClick={() => scene3DBridge.resetModelTransform?.()}
                  className="flex items-center justify-center gap-1 py-1 rounded bg-[#161616] hover:bg-[#2c2c2c] border border-white/[0.06] text-[10px] text-[#8a8a8a] hover:text-[#e5e5e5] disabled:opacity-40 cursor-pointer"
                >
                  <RotateCcw className="w-3 h-3" />
                  <span>Reset</span>
                </button>
              </div>
            </div>
          </>
        )}

        {activeTab === 'light' && (
          <>
            {/* Key Light Toggle + Interactive 3D Sphere */}
            <div className="space-y-1.5">
              <label className="flex items-center justify-between text-[11px] text-[#cccccc] cursor-pointer">
                <span>Key Light Enabled</span>
                <input
                  type="checkbox"
                  checked={lighting.keyLight.enabled}
                  onChange={(e) => store3DActions.updateKeyLight({ enabled: e.target.checked })}
                />
              </label>
              <LightSourceWidget
                embedded
                compact
                settings={{
                  azimuth: lighting.keyLight.azimuth,
                  elevation: lighting.keyLight.elevation,
                  intensity: lighting.keyLight.intensity,
                  ambientIntensity: lighting.ambientIntensity,
                  color: lighting.keyLight.color,
                  isBacklit: lighting.keyLight.isBacklit,
                }}
                onChange={(next) => {
                  store3DActions.updateKeyLight({
                    azimuth: next.azimuth,
                    elevation: next.elevation,
                    intensity: next.intensity,
                    color: next.color,
                    isBacklit: next.isBacklit,
                  });
                  store3DActions.updateLighting({ ambientIntensity: next.ambientIntensity });
                }}
                onReset={() => store3DActions.resetLighting()}
              />
            </div>

            {/* Secondary Light Source (Rim / Fill Light) */}
            <div className="space-y-1.5 pt-2 border-t border-white/[0.06]">
              <div className="flex items-center justify-between">
                <label className="flex items-center gap-1.5 text-[11px] text-[#cccccc] cursor-pointer">
                  <input
                    type="checkbox"
                    checked={lighting.rimLight.enabled}
                    onChange={(e) => store3DActions.updateRimLight({ enabled: e.target.checked })}
                  />
                  <span>Light 2 (Rim / Fill)</span>
                </label>
                <input
                  type="color"
                  value={lighting.rimLight.color}
                  onChange={(e) => store3DActions.updateRimLight({ color: e.target.value })}
                  title="Rim Light Color"
                  className="w-5 h-4 bg-transparent border-0 cursor-pointer p-0"
                />
              </div>

              {lighting.rimLight.enabled && (
                <div className="space-y-1.5 bg-[#161616] p-2 rounded border border-white/[0.06]">
                  <div className="space-y-0.5">
                    <div className="flex justify-between text-[10px]">
                      <span className="text-[#8a8a8a]">Angle</span>
                      <span className="font-mono text-[#e5e5e5]">{lighting.rimLight.azimuth}°</span>
                    </div>
                    <input
                      type="range"
                      min={0}
                      max={360}
                      step={5}
                      value={lighting.rimLight.azimuth}
                      onChange={(e) =>
                        store3DActions.updateRimLight({ azimuth: parseInt(e.target.value, 10) })
                      }
                      className="w-full"
                    />
                  </div>
                  <div className="space-y-0.5">
                    <div className="flex justify-between text-[10px]">
                      <span className="text-[#8a8a8a]">Height</span>
                      <span className="font-mono text-[#e5e5e5]">{lighting.rimLight.elevation}°</span>
                    </div>
                    <input
                      type="range"
                      min={-60}
                      max={85}
                      step={5}
                      value={lighting.rimLight.elevation}
                      onChange={(e) =>
                        store3DActions.updateRimLight({ elevation: parseInt(e.target.value, 10) })
                      }
                      className="w-full"
                    />
                  </div>
                  <div className="space-y-0.5">
                    <div className="flex justify-between text-[10px]">
                      <span className="text-[#8a8a8a]">Intensity</span>
                      <span className="font-mono text-[#e5e5e5]">
                        {Math.round(lighting.rimLight.intensity * 100)}%
                      </span>
                    </div>
                    <input
                      type="range"
                      min={0}
                      max={2.5}
                      step={0.05}
                      value={lighting.rimLight.intensity}
                      onChange={(e) =>
                        store3DActions.updateRimLight({ intensity: parseFloat(e.target.value) })
                      }
                      className="w-full"
                    />
                  </div>
                </div>
              )}
            </div>

            {/* Ambient Tint & Ground Shadow */}
            <div className="space-y-1.5 pt-2 border-t border-white/[0.06]">
              <div className="flex items-center justify-between text-[10px]">
                <span className="text-[#8a8a8a]">Ambient Color</span>
                <input
                  type="color"
                  value={lighting.ambientColor}
                  onChange={(e) => store3DActions.updateLighting({ ambientColor: e.target.value })}
                  className="w-5 h-4 bg-transparent border-0 cursor-pointer p-0"
                />
              </div>
              <label className="flex items-center justify-between text-[10px] text-[#cccccc] cursor-pointer">
                <span>Cast Ground Shadow</span>
                <input
                  type="checkbox"
                  checked={lighting.castGroundShadow}
                  onChange={(e) =>
                    store3DActions.updateLighting({ castGroundShadow: e.target.checked })
                  }
                />
              </label>
              {lighting.castGroundShadow && (
                <div className="space-y-0.5">
                  <div className="flex justify-between text-[10px]">
                    <span className="text-[#8a8a8a]">Shadow Strength</span>
                    <span className="font-mono text-[#e5e5e5]">
                      {Math.round(lighting.shadowOpacity * 100)}%
                    </span>
                  </div>
                  <input
                    type="range"
                    min={0.05}
                    max={0.85}
                    step={0.05}
                    value={lighting.shadowOpacity}
                    onChange={(e) =>
                      store3DActions.updateLighting({ shadowOpacity: parseFloat(e.target.value) })
                    }
                    className="w-full"
                  />
                </div>
              )}
            </div>
          </>
        )}

        {activeTab === 'scene' && (
          <>
            {/* Camera Angle Presets */}
            <div className="space-y-1">
              <div className="flex items-center justify-between">
                <span className="text-[10px] uppercase tracking-wider text-[#6e6e6e]">
                  Camera Angle
                </span>
                <button
                  type="button"
                  onClick={() => scene3DBridge.resetCamera?.()}
                  className="text-[10px] text-[#8a8a8a] hover:text-[#e5e5e5] cursor-pointer"
                >
                  Reset
                </button>
              </div>
              <div className="grid grid-cols-3 gap-1">
                {(
                  [
                    ['front', 'Front'],
                    ['threeQuarter', '3/4'],
                    ['side', 'Side'],
                    ['back', 'Back'],
                    ['top', 'Top'],
                    ['lowAngle', 'Low'],
                  ] as Array<[Camera3DPreset, string]>
                ).map(([preset, lbl]) => (
                  <button
                    key={preset}
                    type="button"
                    onClick={() => scene3DBridge.setCameraPreset?.(preset)}
                    className="py-1 rounded bg-[#161616] hover:bg-[#2c2c2c] border border-white/[0.06] text-[10px] text-[#cccccc] hover:text-[#e5e5e5] cursor-pointer"
                  >
                    {lbl}
                  </button>
                ))}
              </div>
            </div>

            {/* Shading Style */}
            <div className="space-y-1 pt-1 border-t border-white/[0.06]">
              <span className="text-[10px] uppercase tracking-wider text-[#6e6e6e]">Shading</span>
              <div className="grid grid-cols-3 gap-1">
                {(
                  [
                    ['shaded', 'Shaded'],
                    ['smooth', 'Smooth'],
                    ['toon', 'Cel / Toon'],
                    ['wireframe', 'Wire'],
                    ['silhouette', 'Silh'],
                  ] as Array<[Shading3DMode, string]>
                ).map(([mode, lbl]) => (
                  <button
                    key={mode}
                    type="button"
                    onClick={() => store3DActions.setShadingMode(mode)}
                    className={`py-1 rounded text-[10px] transition-colors cursor-pointer ${
                      shadingMode === mode
                        ? 'bg-[var(--accent)] text-[var(--accent-contrast)] font-medium'
                        : 'bg-[#161616] text-[#8a8a8a] hover:text-[#e5e5e5] hover:bg-[#2c2c2c]'
                    }`}
                  >
                    {lbl}
                  </button>
                ))}
              </div>

              {(shadingMode === 'shaded' || shadingMode === 'smooth') && (
                <div className="space-y-0.5 pt-1">
                  <div className="flex justify-between text-[10px]">
                    <span className="text-[#8a8a8a]">Roughness</span>
                    <span className="font-mono text-[#e5e5e5]">
                      {Math.round(materialRoughness * 100)}%
                    </span>
                  </div>
                  <input
                    type="range"
                    min={0.1}
                    max={1}
                    step={0.05}
                    value={materialRoughness}
                    onChange={(e) => store3DActions.setMaterialRoughness(parseFloat(e.target.value))}
                    className="w-full"
                  />
                </div>
              )}

              <label className="flex items-center justify-between text-[10px] text-[#cccccc] pt-1 cursor-pointer">
                <span>Manga Outline Preview</span>
                <input
                  type="checkbox"
                  checked={toonOutline}
                  onChange={(e) => store3DActions.setToonOutline(e.target.checked)}
                />
              </label>
            </div>

            {/* Perspective & Reference Opacity */}
            <div className="space-y-2 pt-1 border-t border-white/[0.06]">
              <div>
                <div className="flex justify-between text-[10px] mb-0.5">
                  <span className="text-[#8a8a8a]">Perspective (FOV)</span>
                  <span className="font-mono text-[#e5e5e5]">
                    {perspective.toFixed(1)}x · {fov}°
                  </span>
                </div>
                <input
                  type="range"
                  min={0.3}
                  max={2.5}
                  step={0.05}
                  value={perspective}
                  onChange={(e) => scene3DBridge.applyPerspectiveDollyZoom?.(parseFloat(e.target.value))}
                  className="w-full"
                />
              </div>

              <div>
                <div className="flex justify-between text-[10px] mb-0.5">
                  <span className="text-[#8a8a8a]">Stage Opacity</span>
                  <span className="font-mono text-[#e5e5e5]">{Math.round(opacity * 100)}%</span>
                </div>
                <input
                  type="range"
                  min={0.1}
                  max={1}
                  step={0.05}
                  value={opacity}
                  onChange={(e) => store3DActions.setOpacity(parseFloat(e.target.value))}
                  className="w-full"
                />
              </div>
            </div>

            {/* Guides & Perspective Ruler Sync */}
            <div className="space-y-1.5 pt-1 border-t border-white/[0.06]">
              <label className="flex items-center justify-between text-[10px] text-[#cccccc] cursor-pointer">
                <span>Floor Grid</span>
                <input
                  type="checkbox"
                  checked={showGrid}
                  onChange={(e) => store3DActions.setShowGrid(e.target.checked)}
                />
              </label>
              <label className="flex items-center justify-between text-[10px] text-[#cccccc] cursor-pointer">
                <span>Live Sync Perspective Ruler</span>
                <input
                  type="checkbox"
                  checked={syncCameraPerspective}
                  onChange={(e) => store3DActions.setSyncCameraPerspective(e.target.checked)}
                />
              </label>
              <button
                type="button"
                onClick={() => scene3DBridge.syncPerspectiveRulerNow?.()}
                className="w-full flex items-center justify-center gap-1 py-1 rounded bg-[#161616] hover:bg-[#2c2c2c] border border-white/[0.06] text-[10px] text-[#cccccc] hover:text-[#e5e5e5] cursor-pointer"
              >
                <Compass className="w-3 h-3 text-[var(--accent)]" />
                <span>Sync Ruler to Camera Now</span>
              </button>
            </div>
          </>
        )}

        {activeTab === 'pose' && isMannequinActive && (
          <>
            <div className="space-y-1">
              <span className="text-[10px] uppercase tracking-wider text-[#6e6e6e]">
                Pose Presets
              </span>
              <div className="grid grid-cols-2 gap-1">
                {(
                  [
                    ['standing', 'Standing'],
                    ['action', 'Action'],
                    ['sitting', 'Seated'],
                    ['fists', 'Fists'],
                    ['relaxed_palm', 'Relaxed'],
                  ] as Array<[PosePresetName, string]>
                ).map(([preset, lbl]) => (
                  <button
                    key={preset}
                    type="button"
                    onClick={() => scene3DBridge.applyPosePreset?.(preset)}
                    className="py-1.5 px-2 rounded bg-[#161616] hover:bg-[#2c2c2c] border border-white/[0.06] text-[10px] text-[#e5e5e5] text-left cursor-pointer"
                  >
                    {lbl}
                  </button>
                ))}
              </div>
            </div>

            <div className="space-y-1.5 pt-1 border-t border-white/[0.06]">
              <div className="flex items-center justify-between">
                <span className="text-[10px] uppercase tracking-wider text-[#6e6e6e]">
                  IK Limb Handles
                </span>
                {activeIKHandle && (
                  <button
                    type="button"
                    onClick={() => scene3DBridge.selectIKTarget?.(null)}
                    className="text-[10px] text-[#8a8a8a] hover:text-[#e5e5e5] cursor-pointer"
                  >
                    Done
                  </button>
                )}
              </div>
              <p className="text-[10px] text-[#8a8a8a] leading-snug">
                Click any colored joint sphere on the canvas or pick a limb below to drag it.
              </p>
              <div className="grid grid-cols-3 gap-1">
                {(
                  [
                    ['head', 'Head'],
                    ['leftHand', 'L-Hand'],
                    ['rightHand', 'R-Hand'],
                    ['leftFoot', 'L-Foot'],
                    ['rightFoot', 'R-Foot'],
                  ] as const
                ).map(([limb, lbl]) => (
                  <button
                    key={limb}
                    type="button"
                    onClick={() =>
                      scene3DBridge.selectIKTarget?.(activeIKHandle === limb ? null : limb)
                    }
                    className={`py-1 px-1 rounded text-[10px] transition-colors cursor-pointer ${
                      activeIKHandle === limb
                        ? 'bg-[var(--accent)] text-[var(--accent-contrast)] font-medium'
                        : 'bg-[#161616] border border-white/[0.06] text-[#cccccc] hover:bg-[#2c2c2c]'
                    }`}
                  >
                    {lbl}
                  </button>
                ))}
              </div>
              <label className="flex items-center justify-between text-[10px] text-[#cccccc] pt-1 cursor-pointer">
                <span>Show Joint Spheres</span>
                <input
                  type="checkbox"
                  checked={showIKHandles}
                  onChange={(e) => store3DActions.setShowIKHandles(e.target.checked)}
                />
              </label>
            </div>
          </>
        )}

        {/* Collapsible 3D Behavior Rules Reference */}
        <div className="pt-1 border-t border-white/[0.06]">
          <button
            type="button"
            onClick={() => setShowRules((v) => !v)}
            className="w-full flex items-center justify-between text-[10px] text-[#8a8a8a] hover:text-[#e5e5e5] py-0.5 cursor-pointer"
          >
            <span>Controls & Rules</span>
            <span>{showRules ? 'Hide' : 'Show'}</span>
          </button>
          {showRules && (
            <div className="mt-1.5 space-y-1 bg-[#161616] rounded p-1.5 border border-white/[0.06]">
              {TOOL_3D_BEHAVIOR_RULES.map((rule) => (
                <div key={rule.gesture} className="text-[9px] leading-tight">
                  <span className="font-mono text-[#e5e5e5]">{rule.gesture}: </span>
                  <span className="text-[#8a8a8a]">{rule.action}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Footer Bake / Stamp Actions */}
      <div className="p-2 border-t border-white/[0.06] bg-[#1a1a1a] grid grid-cols-2 gap-1 shrink-0">
        <button
          type="button"
          disabled={isBaking || !hasModel}
          onClick={() => {
            void scene3DBridge.bakeTo2D?.(false);
          }}
          title="Bake a 2D raster copy while keeping the 3D stage open"
          className="flex items-center justify-center gap-1 py-1.5 rounded bg-[#2c2c2c] hover:bg-[#383838] text-[10px] text-[#e5e5e5] disabled:opacity-40 cursor-pointer"
        >
          <CopyPlus className="w-3 h-3" />
          <span>Stamp</span>
        </button>
        <button
          type="button"
          disabled={isBaking || !hasModel}
          onClick={() => {
            void scene3DBridge.bakeTo2D?.(true);
          }}
          title="Rasterize 3D model into a 2D Layer and close stage"
          className="flex items-center justify-center gap-1 py-1.5 rounded bg-[var(--accent)] text-[var(--accent-contrast)] hover:opacity-90 text-[10px] font-medium disabled:opacity-40 cursor-pointer"
        >
          <Layers className="w-3 h-3" />
          <span>{isBaking ? 'Baking...' : 'Bake Layer'}</span>
        </button>
      </div>
    </div>
  );
};
