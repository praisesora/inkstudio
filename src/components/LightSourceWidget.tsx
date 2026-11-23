import React, { useRef, useEffect, useCallback, useState } from 'react';
import { RotateCcw } from 'lucide-react';
import { sphericalLightToVector } from '../utils/tool3DRules';

export interface LightSettings {
  azimuth: number; // 0 to 360 degrees (horizontal)
  elevation: number; // -85 to 85 degrees (vertical)
  intensity: number; // 0.0 to 3.0
  ambientIntensity: number; // 0.0 to 1.5 (fill light / shadow contrast)
  color: string; // hex
  isBacklit: boolean;
}

interface LightSourceWidgetProps {
  settings: LightSettings;
  onChange: (settings: LightSettings) => void;
  onReset: () => void;
  embedded?: boolean;
  compact?: boolean;
}

export const LightSourceWidget: React.FC<LightSourceWidgetProps> = ({
  settings,
  onChange,
  onReset,
  embedded = false,
  compact = false,
}) => {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const sphereBufferRef = useRef<HTMLCanvasElement | null>(null);
  const isDraggingRef = useRef<boolean>(false);
  const settingsRef = useRef(settings);
  settingsRef.current = settings;
  const [activeTab, setActiveTab] = useState<'sphere' | 'sliders'>('sphere');

  const sphereSize = compact ? 112 : 128;

  // Render the interactive 3D shaded sphere with real-time lighting & directional gizmo
  const renderSphere = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const width = canvas.width;
    const height = canvas.height;
    const cx = width / 2;
    const cy = height / 2;
    const radius = width * 0.41;

    ctx.clearRect(0, 0, width, height);

    // Unified light direction matching Local3DContainer exactly
    const light = sphericalLightToVector(settings.azimuth, settings.elevation, settings.isBacklit, 1);
    const lx = light.x;
    const ly = light.y;
    const lz = light.z;

    // 1. Subtle studio drop shadow beneath the sphere (composited cleanly, never erased by putImageData)
    ctx.beginPath();
    ctx.ellipse(cx, cy + radius * 0.94, radius * 0.78, radius * 0.18, 0, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(0, 0, 0, 0.42)';
    ctx.fill();

    // 2. Render shaded sphere pixels into offscreen buffer so alpha composites over shadow
    if (!sphereBufferRef.current) {
      sphereBufferRef.current = document.createElement('canvas');
    }
    const buf = sphereBufferRef.current;
    if (buf.width !== width || buf.height !== height) {
      buf.width = width;
      buf.height = height;
    }
    const bufCtx = buf.getContext('2d');
    if (!bufCtx) return;

    const imgData = bufCtx.createImageData(width, height);
    const data = imgData.data;

    const hex = settings.color.startsWith('#') && settings.color.length >= 7 ? settings.color : '#ffffff';
    const cr = parseInt(hex.slice(1, 3), 16) || 255;
    const cg = parseInt(hex.slice(3, 5), 16) || 255;
    const cb = parseInt(hex.slice(5, 7), 16) || 255;

    const ambient = Math.min(0.95, Math.max(0.06, settings.ambientIntensity * 0.42));
    const intensity = Math.min(2.6, Math.max(0, settings.intensity));

    for (let py = 0; py < height; py++) {
      for (let px = 0; px < width; px++) {
        const dx = (px - cx) / radius;
        const dy = (cy - py) / radius;
        const d2 = dx * dx + dy * dy;

        if (d2 <= 1.0) {
          const dz = Math.sqrt(Math.max(0, 1.0 - d2));
          const dot = dx * lx + dy * ly + dz * lz;
          const diffuse = Math.max(0, dot);

          // Blinn-Phong specular highlight (view vector = 0,0,1)
          const hx = lx;
          const hy = ly;
          const hz = lz + 1.0;
          const hLen = Math.hypot(hx, hy, hz) || 1;
          const specDot = Math.max(0, (dx * hx + dy * hy + dz * hz) / hLen);
          const specular = Math.pow(specDot, 26) * 0.65 * intensity;

          // Subtle rim glow when backlit so user sees backlight silhouette clearly
          const rim = settings.isBacklit ? Math.pow(1 - dz, 2.5) * 0.55 * intensity : 0;

          const totalLight = ambient + diffuse * 0.78 * intensity + specular + rim;
          const idx = (py * width + px) * 4;

          data[idx] = Math.min(255, Math.round(cr * totalLight * 0.82));
          data[idx + 1] = Math.min(255, Math.round(cg * totalLight * 0.82));
          data[idx + 2] = Math.min(255, Math.round(cb * totalLight * 0.82));
          // Anti-alias outer edge smoothly
          const edgeAlpha = d2 > 0.94 ? Math.max(0, (1 - d2) / 0.06) : 1;
          data[idx + 3] = Math.round(edgeAlpha * 255);
        }
      }
    }

    bufCtx.putImageData(imgData, 0, 0);
    ctx.drawImage(buf, 0, 0);

    // 3. Rim contour ring
    ctx.beginPath();
    ctx.arc(cx, cy, radius, 0, Math.PI * 2);
    ctx.strokeStyle = settings.isBacklit ? 'rgba(248, 113, 113, 0.7)' : 'rgba(56, 189, 248, 0.45)';
    ctx.lineWidth = 1.5;
    ctx.stroke();

    // 4. Directional vector guide and draggable sun handle
    const handleX = cx + lx * radius * 0.85;
    const handleY = cy - ly * radius * 0.85;

    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.lineTo(handleX, handleY);
    ctx.strokeStyle = settings.isBacklit ? '#f87171' : '#38bdf8';
    ctx.lineWidth = 1.75;
    ctx.setLineDash([3, 2]);
    ctx.stroke();
    ctx.setLineDash([]);

    ctx.beginPath();
    ctx.arc(handleX, handleY, 5.5, 0, Math.PI * 2);
    ctx.fillStyle = settings.isBacklit ? '#f87171' : '#fde047';
    ctx.shadowColor = settings.isBacklit ? '#ef4444' : '#fbbf24';
    ctx.shadowBlur = 7;
    ctx.fill();
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 1.5;
    ctx.stroke();
    ctx.shadowBlur = 0;
  }, [settings]);

  useEffect(() => {
    renderSphere();
  }, [renderSphere]);

  // Direct click & drag on the 3D Light Sphere (Clip Studio Paint style)
  const handlePointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    e.preventDefault();
    e.stopPropagation();

    const canvas = canvasRef.current;
    if (!canvas) return;

    try {
      canvas.setPointerCapture(e.pointerId);
    } catch {
      // ignore
    }
    isDraggingRef.current = true;

    const updateFromPointer = (clientX: number, clientY: number) => {
      const rect = canvas.getBoundingClientRect();
      const cx = rect.left + rect.width / 2;
      const cy = rect.top + rect.height / 2;
      const radius = (rect.width / 2) * 0.85;

      let dx = (clientX - cx) / radius;
      let dy = -(clientY - cy) / radius;

      const dist = Math.hypot(dx, dy);
      if (dist > 1.0) {
        dx /= dist;
        dy /= dist;
      }

      const elevation = Math.round(Math.asin(Math.max(-0.99, Math.min(0.99, dy))) * (180 / Math.PI));
      const forward = Math.sqrt(Math.max(0, 1 - dx * dx - dy * dy));
      let azimuth = Math.round(Math.atan2(dx, forward) * (180 / Math.PI));
      if (azimuth < 0) azimuth += 360;

      onChange({
        ...settingsRef.current,
        azimuth,
        elevation,
      });
    };

    updateFromPointer(e.clientX, e.clientY);

    const onPointerMove = (ev: PointerEvent) => {
      if (!isDraggingRef.current) return;
      updateFromPointer(ev.clientX, ev.clientY);
    };

    const onPointerUp = (ev: PointerEvent) => {
      isDraggingRef.current = false;
      try {
        canvas.releasePointerCapture(ev.pointerId);
      } catch {
        // ignore
      }
      window.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('pointerup', onPointerUp);
      window.removeEventListener('pointercancel', onPointerUp);
    };

    window.addEventListener('pointermove', onPointerMove);
    window.addEventListener('pointerup', onPointerUp);
    window.addEventListener('pointercancel', onPointerUp);
  };

  const colorPresets = [
    { label: 'White', color: '#ffffff' },
    { label: 'Warm Sun', color: '#fff3db' },
    { label: 'Golden Hour', color: '#ffb56b' },
    { label: 'Cool Sky', color: '#dbeafe' },
    { label: 'Cyber Cyan', color: '#67e8f9' },
  ];

  return (
    <div
      className={
        embedded
          ? 'bg-[#161616] border border-white/[0.06] rounded-md p-2 w-full text-xs text-[#e5e5e5] select-none'
          : 'bg-[#202020]/95 border border-white/[0.1] rounded-lg p-2.5 shadow-2xl backdrop-blur-md w-60 text-xs text-[#e5e5e5] select-none'
      }
      onPointerDown={(e) => e.stopPropagation()}
    >
      <div className="flex items-center justify-between border-b border-white/[0.06] pb-1.5 mb-2">
        <span className="text-[11px] font-medium text-[#e5e5e5]">Key Light</span>
        <div className="flex items-center space-x-1">
          <button
            type="button"
            onClick={() => setActiveTab(activeTab === 'sphere' ? 'sliders' : 'sphere')}
            className="text-[10px] px-1.5 py-0.5 rounded bg-[#2c2c2c] hover:bg-[#383838] text-[#cccccc] cursor-pointer"
          >
            {activeTab === 'sphere' ? 'Sliders' : 'Sphere'}
          </button>
          <button
            type="button"
            onClick={onReset}
            title="Reset Lighting to Studio Default"
            className="p-1 rounded text-[#8a8a8a] hover:text-[#e5e5e5] hover:bg-[#2c2c2c] cursor-pointer"
          >
            <RotateCcw className="w-3 h-3" />
          </button>
        </div>
      </div>

      {activeTab === 'sphere' ? (
        <div className="flex flex-col items-center">
          <div className="relative group cursor-crosshair">
            <canvas
              ref={canvasRef}
              width={sphereSize}
              height={sphereSize}
              onPointerDown={handlePointerDown}
              className="rounded-full border border-white/[0.1] bg-[#111111]"
              style={{ touchAction: 'none' }}
            />
            <div className="absolute inset-0 pointer-events-none flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity">
              <span className="text-[9px] bg-black/75 px-1.5 py-0.5 rounded text-[#e5e5e5]">
                Drag light angle
              </span>
            </div>
          </div>

          <div className="flex items-center justify-between w-full mt-2 px-0.5">
            <button
              type="button"
              onClick={() => onChange({ ...settings, isBacklit: !settings.isBacklit })}
              className={`text-[10px] px-2 py-0.5 rounded font-medium transition-colors cursor-pointer ${
                settings.isBacklit
                  ? 'bg-[var(--accent-subtle)] text-[var(--accent)] ring-1 ring-[var(--accent-border)]'
                  : 'bg-[#2c2c2c] text-[#cccccc] hover:text-[#e5e5e5]'
              }`}
            >
              {settings.isBacklit ? 'Backlight' : 'Front Light'}
            </button>
            <span className="text-[10px] font-mono text-[#8a8a8a]">
              {settings.azimuth}° / {settings.elevation}°
            </span>
          </div>
        </div>
      ) : (
        <div className="space-y-2 py-1">
          <div className="flex items-center justify-between gap-2">
            <span className="text-[10px] text-[#8a8a8a] w-14">Azimuth</span>
            <input
              type="range"
              min="0"
              max="360"
              step="1"
              value={settings.azimuth}
              onChange={(e) => onChange({ ...settings, azimuth: parseInt(e.target.value, 10) })}
              className="flex-1"
            />
            <span className="text-[10px] font-mono w-8 text-right text-[#e5e5e5]">{settings.azimuth}°</span>
          </div>

          <div className="flex items-center justify-between gap-2">
            <span className="text-[10px] text-[#8a8a8a] w-14">Elevation</span>
            <input
              type="range"
              min="-85"
              max="85"
              step="1"
              value={settings.elevation}
              onChange={(e) => onChange({ ...settings, elevation: parseInt(e.target.value, 10) })}
              className="flex-1"
            />
            <span className="text-[10px] font-mono w-8 text-right text-[#e5e5e5]">{settings.elevation}°</span>
          </div>
        </div>
      )}

      {/* Intensity, Fill & Color Controls */}
      <div className="mt-2 pt-2 border-t border-white/[0.06] space-y-1.5">
        <div className="flex items-center justify-between gap-2">
          <span className="text-[10px] text-[#8a8a8a] w-12">Power</span>
          <input
            type="range"
            min="0"
            max="3"
            step="0.05"
            value={settings.intensity}
            onChange={(e) => onChange({ ...settings, intensity: parseFloat(e.target.value) })}
            className="flex-1"
          />
          <span className="text-[10px] font-mono w-8 text-right text-[#e5e5e5]">
            {Math.round(settings.intensity * 100)}%
          </span>
        </div>

        <div className="flex items-center justify-between gap-2">
          <span className="text-[10px] text-[#8a8a8a] w-12">Ambient</span>
          <input
            type="range"
            min="0"
            max="1.5"
            step="0.05"
            value={settings.ambientIntensity}
            onChange={(e) => onChange({ ...settings, ambientIntensity: parseFloat(e.target.value) })}
            className="flex-1"
          />
          <span className="text-[10px] font-mono w-8 text-right text-[#e5e5e5]">
            {Math.round(settings.ambientIntensity * 100)}%
          </span>
        </div>

        {/* Color Presets + Custom Picker */}
        <div className="flex items-center justify-between pt-1 gap-1">
          <span className="text-[10px] text-[#8a8a8a]">Color</span>
          <div className="flex items-center space-x-1">
            {colorPresets.map((preset) => (
              <button
                key={preset.label}
                type="button"
                onClick={() => onChange({ ...settings, color: preset.color })}
                title={preset.label}
                className={`w-3.5 h-3.5 rounded-full border transition-transform cursor-pointer ${
                  settings.color.toLowerCase() === preset.color.toLowerCase()
                    ? 'scale-110 border-[var(--accent)] ring-1 ring-[var(--accent)]'
                    : 'border-white/30 hover:scale-105'
                }`}
                style={{ backgroundColor: preset.color }}
              />
            ))}
            <input
              type="color"
              value={settings.color}
              onChange={(e) => onChange({ ...settings, color: e.target.value })}
              title="Custom Light Color"
              className="w-4 h-4 rounded bg-transparent border-0 cursor-pointer p-0"
            />
          </div>
        </div>
      </div>
    </div>
  );
};
