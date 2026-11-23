import React, { useRef, useCallback, useState } from 'react';
import {
  X,
  Box,
  Sun,
  Magnet,
  HelpCircle,
  Eye,
  EyeOff,
  RotateCw,
  Move,
  Maximize2,
  Ban,
  Upload,
  Layers,
  Undo2,
  Redo2,
} from 'lucide-react';
import {
  Gizmo3DMode,
  TOOL_3D_BEHAVIOR_RULES,
  Tool3DMode,
} from '../utils/tool3DRules';
import { LightSourceWidget } from './LightSourceWidget';
import { store3DActions, use3DStore } from '../stores';

export type Csp3DToolMode = Tool3DMode;

interface Csp3DToolbarProps {
  is3DToolActive: boolean;
  onActivate3DTool: () => void;
  onDirectDrag: (mode: Tool3DMode, deltaX: number, deltaY: number, snap: boolean) => void;
  onDirectDragEnd: () => void;
  onTriggerImport: () => void;
  onSnapToGround: () => void;
  onUndo: () => void;
  onRedo: () => void;
  onOpenLTModal: () => void;
  isLTModalOpen?: boolean;
  onBakeTo2D: (closeAfter: boolean) => void;
  onClose: () => void;
}

const OBJECT_MODES: Array<{ mode: Tool3DMode; label: string; title: string }> = [
  {
    mode: 'smart',
    label: 'Smart',
    title: 'Smart CSP mode: drag model to transform, drag background to orbit',
  },
  {
    mode: 'model-rotate',
    label: 'Rotate',
    title: 'Rotate model freely (click to select or drag button directly)',
  },
  {
    mode: 'model-move',
    label: 'Move',
    title: 'Move model in view plane (click to select or drag button directly)',
  },
  {
    mode: 'model-scale',
    label: 'Scale',
    title: 'Scale model uniformly (click to select or drag button directly)',
  },
  {
    mode: 'model-plane-move',
    label: 'Floor',
    title: 'Slide model along ground floor plane (click or drag)',
  },
];

const CAMERA_MODES: Array<{ mode: Tool3DMode; label: string; title: string }> = [
  { mode: 'camera-orbit', label: 'Orbit', title: 'Orbit camera around model (click or drag)' },
  { mode: 'camera-pan', label: 'Pan', title: 'Pan camera in screen plane (click or drag)' },
  { mode: 'camera-zoom', label: 'Zoom', title: 'Zoom camera distance (click or drag)' },
];

const GIZMO_BUTTONS: Array<{
  mode: Gizmo3DMode;
  label: string;
  icon: React.ReactNode;
}> = [
  { mode: 'rotate', label: 'Rotate Gizmo', icon: <RotateCw className="w-3 h-3" /> },
  { mode: 'translate', label: 'Move Gizmo', icon: <Move className="w-3 h-3" /> },
  { mode: 'scale', label: 'Scale Gizmo', icon: <Maximize2 className="w-3 h-3" /> },
  { mode: 'none', label: 'Hide Gizmo', icon: <Ban className="w-3 h-3" /> },
];

export const Csp3DToolbar: React.FC<Csp3DToolbarProps> = ({
  is3DToolActive,
  onActivate3DTool,
  onDirectDrag,
  onDirectDragEnd,
  onTriggerImport,
  onSnapToGround,
  onUndo,
  onRedo,
  onOpenLTModal,
  isLTModalOpen = false,
  onBakeTo2D,
  onClose,
}) => {
  const activeMode = use3DStore((s) => s.activeMode);
  const gizmoMode = use3DStore((s) => s.gizmoMode);
  const loadedModelName = use3DStore((s) => s.loadedModelName);
  const isBaking = use3DStore((s) => s.isBaking);
  const canUndo3D = use3DStore((s) => s.canUndo3D);
  const canRedo3D = use3DStore((s) => s.canRedo3D);
  const isReferenceVisible = use3DStore((s) => s.isReferenceVisible);
  const lighting = use3DStore((s) => s.lighting);

  const [openPopover, setOpenPopover] = useState<'light' | 'help' | null>(null);
  const hasModel = Boolean(loadedModelName);

  const dragRef = useRef<{
    mode: Tool3DMode;
    startX: number;
    startY: number;
    lastX: number;
    lastY: number;
    hasDragged: boolean;
  } | null>(null);

  const handleModeButtonPointerDown = useCallback(
    (mode: Tool3DMode, e: React.PointerEvent<HTMLButtonElement>) => {
      e.preventDefault();
      e.stopPropagation();

      if (mode === 'smart') {
        store3DActions.setActiveMode('smart');
        return;
      }

      const target = e.currentTarget;
      try {
        target.setPointerCapture(e.pointerId);
      } catch {
        // ignore
      }

      dragRef.current = {
        mode,
        startX: e.clientX,
        startY: e.clientY,
        lastX: e.clientX,
        lastY: e.clientY,
        hasDragged: false,
      };

      const handlePointerMove = (ev: PointerEvent) => {
        if (!dragRef.current) return;
        const dx = ev.clientX - dragRef.current.lastX;
        const dy = ev.clientY - dragRef.current.lastY;

        if (
          Math.hypot(ev.clientX - dragRef.current.startX, ev.clientY - dragRef.current.startY) > 3
        ) {
          dragRef.current.hasDragged = true;
        }

        dragRef.current.lastX = ev.clientX;
        dragRef.current.lastY = ev.clientY;

        if (dx !== 0 || dy !== 0) {
          onDirectDrag(mode, dx, dy, ev.shiftKey);
        }
      };

      const handlePointerUp = (ev: PointerEvent) => {
        try {
          target.releasePointerCapture(ev.pointerId);
        } catch {
          // ignore
        }
        window.removeEventListener('pointermove', handlePointerMove);
        window.removeEventListener('pointerup', handlePointerUp);
        window.removeEventListener('pointercancel', handlePointerUp);

        if (dragRef.current) {
          if (dragRef.current.hasDragged) {
            onDirectDragEnd();
          } else {
            store3DActions.setActiveMode(mode);
            if (mode === 'model-rotate' || mode === 'model-rotate-yaw' || mode === 'model-rotate-roll') {
              store3DActions.setGizmoMode('rotate');
            } else if (mode === 'model-move' || mode === 'model-plane-move') {
              store3DActions.setGizmoMode('translate');
            } else if (mode === 'model-scale') {
              store3DActions.setGizmoMode('scale');
            }
          }
        }
        dragRef.current = null;
      };

      window.addEventListener('pointermove', handlePointerMove);
      window.addEventListener('pointerup', handlePointerUp);
      window.addEventListener('pointercancel', handlePointerUp);
    },
    [onDirectDrag, onDirectDragEnd]
  );

  // Minimized non-intrusive pill while user is painting with a 2D tool over the live 3D reference
  if (!is3DToolActive) {
    return (
      <div
        className="fixed top-12 left-1/2 -translate-x-1/2 z-40 bg-[#202020]/90 backdrop-blur-md border border-white/[0.1] rounded-full px-2.5 py-1 shadow-xl flex items-center gap-2 text-[11px] text-[#e5e5e5] select-none"
        onPointerDown={(e) => e.stopPropagation()}
      >
        <span className="flex items-center gap-1.5 text-[#a3a3a3]">
          <Box className="w-3.5 h-3.5 text-[var(--accent)]" />
          <span className="max-w-[120px] truncate">{loadedModelName || '3D Reference'}</span>
        </span>
        <button
          type="button"
          onClick={onActivate3DTool}
          title="Switch to 3D Tool (K) to rotate, move, scale, or adjust lighting"
          className="px-2 py-0.5 rounded-full bg-[var(--accent)] text-[var(--accent-contrast)] font-medium hover:opacity-90 transition-opacity cursor-pointer"
        >
          Edit 3D (K)
        </button>
        <button
          type="button"
          onClick={() => store3DActions.toggleReferenceVisible()}
          title={isReferenceVisible ? 'Hide 3D Reference' : 'Show 3D Reference'}
          className="p-1 rounded-full text-[#8a8a8a] hover:text-[#e5e5e5] hover:bg-[#2c2c2c] cursor-pointer"
        >
          {isReferenceVisible ? <Eye className="w-3.5 h-3.5" /> : <EyeOff className="w-3.5 h-3.5" />}
        </button>
        <button
          type="button"
          onClick={onClose}
          title="Close 3D Stage"
          className="p-1 rounded-full text-[#8a8a8a] hover:text-[#e5e5e5] hover:bg-[#2c2c2c] cursor-pointer"
        >
          <X className="w-3.5 h-3.5" />
        </button>
      </div>
    );
  }

  return (
    <div
      className="fixed top-12 left-1/2 -translate-x-1/2 z-50 bg-[#202020]/95 backdrop-blur-md border border-white/[0.1] rounded-lg px-2 py-1 shadow-2xl flex items-center gap-1.5 text-xs text-[#e5e5e5] select-none max-w-[calc(100vw-24px)]"
      onPointerDown={(e) => e.stopPropagation()}
    >
      {/* 1. Import 3D Model */}
      <button
        type="button"
        onClick={onTriggerImport}
        title="Import 3D Model (.glb, .gltf, .obj)"
        className={`flex items-center gap-1 px-2 py-1 rounded text-[11px] border border-white/[0.06] transition-colors cursor-pointer max-w-[110px] truncate ${
          loadedModelName
            ? 'bg-[#2c2c2c] text-[#e5e5e5] font-medium'
            : 'bg-[#161616] text-[#cccccc] hover:text-[#e5e5e5] hover:bg-[#2c2c2c]'
        }`}
      >
        <Upload className="w-3 h-3 shrink-0 text-[var(--accent)]" />
        <span className="truncate">{loadedModelName || 'Import 3D'}</span>
      </button>

      <div className="w-px h-4 bg-white/[0.08]" />

      {/* 2. Object Transform Modes (Click or Scrub-Drag) */}
      <div className="flex items-center bg-[#161616] rounded p-0.5 border border-white/[0.06]">
        {OBJECT_MODES.map((item) => (
          <button
            key={item.mode}
            type="button"
            onPointerDown={(e) => handleModeButtonPointerDown(item.mode, e)}
            title={item.title}
            className={`px-2 py-0.5 rounded text-[11px] transition-colors cursor-pointer ${
              activeMode === item.mode
                ? 'bg-[var(--accent)] text-[var(--accent-contrast)] font-medium'
                : 'text-[#8a8a8a] hover:text-[#e5e5e5] hover:bg-[#2c2c2c]'
            }`}
          >
            {item.label}
          </button>
        ))}
      </div>

      {/* 3. Camera Modes (Click or Scrub-Drag) */}
      <div className="flex items-center bg-[#161616] rounded p-0.5 border border-white/[0.06]">
        <span className="px-1 text-[10px] text-[#666666] font-medium">Cam</span>
        {CAMERA_MODES.map((item) => (
          <button
            key={item.mode}
            type="button"
            onPointerDown={(e) => handleModeButtonPointerDown(item.mode, e)}
            title={item.title}
            className={`px-1.5 py-0.5 rounded text-[11px] transition-colors cursor-pointer ${
              activeMode === item.mode
                ? 'bg-[var(--accent)] text-[var(--accent-contrast)] font-medium'
                : 'text-[#8a8a8a] hover:text-[#e5e5e5] hover:bg-[#2c2c2c]'
            }`}
          >
            {item.label}
          </button>
        ))}
      </div>

      <div className="w-px h-4 bg-white/[0.08]" />

      {/* 4. On-Canvas Gizmo Mode + Snap Floor + Undo/Redo */}
      <div className="flex items-center bg-[#161616] rounded p-0.5 border border-white/[0.06]">
        {GIZMO_BUTTONS.map((g) => (
          <button
            key={g.mode}
            type="button"
            onClick={() => store3DActions.setGizmoMode(g.mode)}
            title={g.label}
            className={`p-1 rounded transition-colors cursor-pointer ${
              gizmoMode === g.mode
                ? 'bg-[#2c2c2c] text-[var(--accent)]'
                : 'text-[#8a8a8a] hover:text-[#e5e5e5] hover:bg-[#2c2c2c]'
            }`}
          >
            {g.icon}
          </button>
        ))}
      </div>

      <button
        type="button"
        onClick={onSnapToGround}
        disabled={!hasModel}
        title="Snap Model to Ground Floor (Y = 0)"
        className="p-1 rounded text-[#8a8a8a] hover:text-[#e5e5e5] hover:bg-[#2c2c2c] disabled:opacity-40 cursor-pointer"
      >
        <Magnet className="w-3.5 h-3.5" />
      </button>

      <div className="flex items-center">
        <button
          type="button"
          onClick={onUndo}
          disabled={!canUndo3D}
          title="Undo 3D Action (Ctrl+Z)"
          className="p-1 rounded text-[#8a8a8a] hover:text-[#e5e5e5] hover:bg-[#2c2c2c] disabled:opacity-30 disabled:cursor-not-allowed cursor-pointer"
        >
          <Undo2 className="w-3.5 h-3.5" />
        </button>
        <button
          type="button"
          onClick={onRedo}
          disabled={!canRedo3D}
          title="Redo 3D Action (Ctrl+Y)"
          className="p-1 rounded text-[#8a8a8a] hover:text-[#e5e5e5] hover:bg-[#2c2c2c] disabled:opacity-30 disabled:cursor-not-allowed cursor-pointer"
        >
          <Redo2 className="w-3.5 h-3.5" />
        </button>
      </div>

      {/* 5. Quick Lighting Popover */}
      <div className="relative">
        <button
          type="button"
          onClick={() => setOpenPopover((p) => (p === 'light' ? null : 'light'))}
          title="Quick Lighting & 3D Light Sphere"
          className={`p-1 rounded transition-colors cursor-pointer ${
            openPopover === 'light'
              ? 'bg-[var(--accent-subtle)] text-[var(--accent)]'
              : 'text-[#8a8a8a] hover:text-[#e5e5e5] hover:bg-[#2c2c2c]'
          }`}
        >
          <Sun className="w-3.5 h-3.5" />
        </button>

        {openPopover === 'light' && (
          <div className="absolute top-full mt-2 right-0 w-64 bg-[#202020] border border-white/[0.1] rounded-lg p-2.5 shadow-2xl z-50">
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
        )}
      </div>

      {/* 6. Behavior Rules Help Popover */}
      <div className="relative">
        <button
          type="button"
          onClick={() => setOpenPopover((p) => (p === 'help' ? null : 'help'))}
          title="3D Tool Controls & Behavior Rules"
          className={`p-1 rounded transition-colors cursor-pointer ${
            openPopover === 'help'
              ? 'bg-[var(--accent-subtle)] text-[var(--accent)]'
              : 'text-[#8a8a8a] hover:text-[#e5e5e5] hover:bg-[#2c2c2c]'
          }`}
        >
          <HelpCircle className="w-3.5 h-3.5" />
        </button>

        {openPopover === 'help' && (
          <div className="absolute top-full mt-2 right-0 w-72 bg-[#202020] border border-white/[0.1] rounded-lg p-3 shadow-2xl z-50 space-y-2">
            <div className="flex items-center justify-between pb-1.5 border-b border-white/[0.06]">
              <span className="text-[11px] font-medium text-[#e5e5e5]">3D Tool Behavior Rules</span>
              <button
                type="button"
                onClick={() => setOpenPopover(null)}
                className="text-[#8a8a8a] hover:text-[#e5e5e5] cursor-pointer"
              >
                <X className="w-3.5 h-3.5" />
              </button>
            </div>
            <div className="space-y-1.5">
              {TOOL_3D_BEHAVIOR_RULES.map((rule) => (
                <div key={rule.gesture} className="flex items-start justify-between gap-2 text-[10px]">
                  <span className="font-mono text-[#e5e5e5] shrink-0">{rule.gesture}</span>
                  <span className="text-[#8a8a8a] text-right">{rule.action}</span>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>

      <div className="w-px h-4 bg-white/[0.08]" />

      {/* 7. Open Separate Line & Tone Extraction Modal with Live Preview */}
      <button
        type="button"
        onClick={() => {
          setOpenPopover(null);
          onOpenLTModal();
        }}
        disabled={isBaking || !hasModel}
        title="Open Line & Tone Extraction Preview Dialog"
        className={`px-2 py-1 rounded text-[11px] font-medium transition-colors cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed ${
          isLTModalOpen
            ? 'bg-[var(--accent-subtle)] text-[var(--accent)] ring-1 ring-[var(--accent-border)]'
            : 'bg-[#2c2c2c] text-[#e5e5e5] hover:bg-[#383838]'
        }`}
      >
        LT
      </button>

      {/* 8. Primary Bake Action (Shift+Click stamps a copy without closing!) */}
      <button
        type="button"
        onClick={(e) => onBakeTo2D(!e.shiftKey)}
        disabled={isBaking || !hasModel}
        title={
          !hasModel
            ? 'Load a 3D model first'
            : 'Rasterize 3D view into a 2D Layer (Shift+Click to keep 3D stage open)'
        }
        className="flex items-center gap-1 px-2.5 py-1 bg-[var(--accent)] text-[var(--accent-contrast)] hover:opacity-90 font-medium rounded text-[11px] transition-opacity disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer"
      >
        <Layers className="w-3 h-3" />
        <span>{isBaking ? 'Baking...' : 'Bake'}</span>
      </button>

      {/* 9. Reference Visibility & Close */}
      <button
        type="button"
        onClick={() => store3DActions.toggleReferenceVisible()}
        title={isReferenceVisible ? 'Hide 3D Reference' : 'Show 3D Reference'}
        className="p-1 text-[#8a8a8a] hover:text-[#e5e5e5] hover:bg-[#2c2c2c] rounded transition-colors cursor-pointer"
      >
        {isReferenceVisible ? <Eye className="w-3.5 h-3.5" /> : <EyeOff className="w-3.5 h-3.5" />}
      </button>

      <button
        type="button"
        onClick={onClose}
        title="Close 3D Stage"
        className="p-1 text-[#8a8a8a] hover:text-[#e5e5e5] hover:bg-[#2c2c2c] rounded transition-colors cursor-pointer"
      >
        <X className="w-3.5 h-3.5" />
      </button>
    </div>
  );
};
