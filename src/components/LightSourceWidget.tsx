import React, { useRef, useEffect, useCallback, useState } from 'react';
import { RotateCcw } from 'lucide-react';

export interface LightSettings {
  azimuth: number; // 0 to 360 degrees (horizontal)
  elevation: number; // -85 to 85 degrees (vertical)
  intensity: number; // 0.2 to 3.0
  ambientIntensity: number; // 0.1 to 1.5 (fill light / shadow contrast)
  color: string; // hex
  isBacklit: boolean;
}

interface LightSourceWidgetProps {
  settings: LightSettings;
  onChange: (settings: LightSettings) => void;
  onReset: () => void;
  embedded?: boolean;
}

export const LightSourceWidget: React.FC<LightSourceWidgetProps> = ({
  settings,
  onChange,
  onReset,
  embedded = false,
}) => {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const isDraggingRef = useRef<boolean>(false);
  const [activeTab, setActiveTab] = useState<'sphere' | 'sliders'>('sphere');

  // Convert spherical angles to normalized 3D unit vector [x, y, z]
  const getLightVector = useCallback(
    (azimuthDeg: number, elevationDeg: number, isBacklit: boolean) => {
      const az = (azimuthDeg * Math.PI) / 180;
      const el = (elevationDeg * Math.PI) / 180;
      // In Three.js coordinates: Y is up, X is right, Z is front
      const y = Math.sin(el);
      const hyp = Math.cos(el);
      const x = hyp * Math.sin(az);
      let z = hyp * Math.cos(az);
      if (isBacklit) z = -Math.abs(z);
      return { x, y, z };
    },
    []
  );

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
    const radius = width * 0.42;

    ctx.clearRect(0, 0, width, height);

    // Calculate normalized light vector
    const light = getLightVector(settings.azimuth, settings.elevation, settings.isBacklit);
    const lightLen = Math.hypot(light.x, light.y, light.z) || 1;
    const lx = light.x / lightLen;
    const ly = light.y / lightLen;
    const lz = light.z / lightLen;

    // 1. Drop shadow beneath the 3D sphere
    ctx.beginPath();
    ctx.ellipse(cx, cy + radius * 0.88, radius * 0.85, radius * 0.25, 0, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(0, 0, 0, 0.4)';
    ctx.fill();

    // 2. Base Sphere render with Phong/Lambertian shading
    const imgData = ctx.createImageData(width, height);
    const data = imgData.data;

    // Parse light color hex
    const cr = parseInt(settings.color.slice(1, 3), 16) || 255;
    const cg = parseInt(settings.color.slice(3, 5), 16) || 255;
    const cb = parseInt(settings.color.slice(5, 7), 16) || 255;

    const ambient = Math.min(1.0, Math.max(0.1, settings.ambientIntensity * 0.4));
    const intensity = Math.min(2.5, settings.intensity);

    for (let py = 0; py < height; py++) {
      for (let px = 0; px < width; px++) {
        const dx = (px - cx) / radius;
        const dy = (cy - py) / radius; // Invert Y so up is positive
        const d2 = dx * dx + dy * dy;

        if (d2 <= 1.0) {
          const dz = Math.sqrt(Math.max(0, 1.0 - d2));
          // Normal vector on sphere surface (dx, dy, dz)
          const dot = dx * lx + dy * ly + dz * lz;
          const diffuse = Math.max(0, dot);

          // Blinn-Phong specular highlight
          // View vector is (0, 0, 1)
          const hx = lx;
          const hy = ly;
          const hz = lz + 1.0;
          const hLen = Math.hypot(hx, hy, hz) || 1;
          const specDot = Math.max(0, (dx * hx + dy * hy + dz * hz) / hLen);
          const specular = Math.pow(specDot, 24) * 0.7 * intensity;

          const totalLight = ambient + diffuse * 0.75 * intensity + specular;
          const idx = (py * width + px) * 4;

          data[idx] = Math.min(255, Math.round(cr * totalLight * 0.8));
          data[idx + 1] = Math.min(255, Math.round(cg * totalLight * 0.8));
          data[idx + 2] = Math.min(255, Math.round(cb * totalLight * 0.8));
          data[idx + 3] = 255;
        }
      }
    }

    ctx.putImageData(imgData, 0, 0);

    // 3. Rim contour ring
    ctx.beginPath();
    ctx.arc(cx, cy, radius, 0, Math.PI * 2);
    ctx.strokeStyle = settings.isBacklit ? 'rgba(239, 68, 68, 0.6)' : 'rgba(59, 130, 246, 0.4)';
    ctx.lineWidth = 2;
    ctx.stroke();

    // 4. Directional Arrow and Target Handle
    const handleX = cx + lx * radius * 0.85;
    const handleY = cy - ly * radius * 0.85; // invert Y for screen coords

    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.lineTo(handleX, handleY);
    ctx.strokeStyle = settings.isBacklit ? '#ef4444' : '#38bdf8';
    ctx.lineWidth = 2;
    ctx.setLineDash([3, 2]);
    ctx.stroke();
    ctx.setLineDash([]);

    // Glowing dot at light vector point
    ctx.beginPath();
    ctx.arc(handleX, handleY, 6, 0, Math.PI * 2);
    ctx.fillStyle = settings.isBacklit ? '#f87171' : '#fde047';
    ctx.shadowColor = settings.isBacklit ? '#ef4444' : '#fbbf24';
    ctx.shadowBlur = 8;
    ctx.fill();
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 1.5;
    ctx.stroke();
    ctx.shadowBlur = 0;
  }, [settings, getLightVector]);

  useEffect(() => {
    renderSphere();
  }, [renderSphere]);

  // Handle direct click & drag on the 3D Light Sphere (Clip Studio Paint style)
  const handlePointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    e.preventDefault();
    e.stopPropagation();

    const canvas = canvasRef.current;
    if (!canvas) return;

    canvas.setPointerCapture(e.pointerId);
    isDraggingRef.current = true;

    const updateFromPointer = (clientX: number, clientY: number) => {
      const rect = canvas.getBoundingClientRect();
      const cx = rect.left + rect.width / 2;
      const cy = rect.top + rect.height / 2;
      const radius = (rect.width / 2) * 0.85;

      let dx = (clientX - cx) / radius;
      let dy = -(clientY - cy) / radius; // Invert Y

      const dist = Math.hypot(dx, dy);
      if (dist > 1.0) {
        dx /= dist;
        dy /= dist;
      }

      // Compute spherical angles
      // Elevation from Y (-85° to +85°)
      const elevation = Math.round(Math.asin(Math.max(-0.99, Math.min(0.99, dy))) * (180 / Math.PI));
      // Azimuth from X and remaining forward axis
      let azimuth = Math.round(Math.atan2(dx, Math.sqrt(Math.max(0, 1 - dx * dx - dy * dy))) * (180 / Math.PI));
      if (azimuth < 0) azimuth += 360;

      onChange({
        ...settings,
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
    };

    window.addEventListener('pointermove', onPointerMove);
    window.addEventListener('pointerup', onPointerUp);
  };

  const colorPresets = [
    { label: 'White', color: '#ffffff' },
    { label: 'Warm Sun', color: '#fff3db' },
    { label: 'Golden Hour', color: '#ffb56b' },
    { label: 'Cool Sky', color: '#dbeafe' },
  ];

  return (
    <div
      className={
        embedded
          ? 'bg-[#161616] border border-white/[0.06] rounded-md p-2.5 w-full text-xs text-[#e5e5e5] select-none'
          : 'bg-[#202020]/95 border border-white/[0.1] rounded-lg p-2.5 shadow-2xl backdrop-blur-md w-60 text-xs text-[#e5e5e5] select-none'
      }
      onPointerDown={(e) => e.stopPropagation()}
    >
      <div className="flex items-center justify-between border-b border-white/[0.06] pb-1.5 mb-2">
        <span className="text-[11px] font-medium text-[#e5e5e5]">Light Source</span>
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
            title="Reset Light to Default (Top-Right Front)"
            className="p-1 rounded text-[#8a8a8a] hover:text-[#e5e5e5] hover:bg-[#2c2c2c] cursor-pointer"
          >
            <RotateCcw className="w-3 h-3" />
          </button>
        </div>
      </div>

      {activeTab === 'sphere' ? (
        <div className="flex flex-col items-center">
          {/* Interactive Shaded 3D Sphere */}
          <div className="relative group cursor-crosshair">
            <canvas
              ref={canvasRef}
              width={132}
              height={132}
              onPointerDown={handlePointerDown}
              className="rounded-full border border-white/[0.1]"
              style={{ touchAction: 'none' }}
            />
            <div className="absolute inset-0 pointer-events-none flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity">
              <span className="text-[9px] bg-black/70 px-1.5 py-0.5 rounded text-[#e5e5e5]">
                Drag to angle
              </span>
            </div>
          </div>

          {/* Front / Back Light Toggle */}
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
          {/* Azimuth (Horizontal) */}
          <div className="flex items-center justify-between gap-2">
            <span className="text-[10px] text-[#8a8a8a] w-14">Azimuth</span>
            <input
              type="range"
              min="0"
              max="360"
              step="2"
              value={settings.azimuth}
              onChange={(e) => onChange({ ...settings, azimuth: parseInt(e.target.value, 10) })}
              className="flex-1"
            />
            <span className="text-[10px] font-mono w-7 text-right text-[#e5e5e5]">{settings.azimuth}°</span>
          </div>

          {/* Elevation (Vertical) */}
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
            <span className="text-[10px] font-mono w-7 text-right text-[#e5e5e5]">{settings.elevation}°</span>
          </div>
        </div>
      )}

      {/* Common Controls: Intensity & Ambient Fill */}
      <div className="mt-2.5 pt-2 border-t border-white/[0.06] space-y-1.5">
        <div className="flex items-center justify-between gap-2">
          <span className="text-[10px] text-[#8a8a8a] w-14">Intensity</span>
          <input
            type="range"
            min="0.2"
            max="2.5"
            step="0.05"
            value={settings.intensity}
            onChange={(e) => onChange({ ...settings, intensity: parseFloat(e.target.value) })}
            className="flex-1"
          />
          <span className="text-[10px] font-mono w-8 text-right text-[#e5e5e5]">{Math.round(settings.intensity * 100)}%</span>
        </div>

        <div className="flex items-center justify-between gap-2">
          <span className="text-[10px] text-[#8a8a8a] w-14">Fill</span>
          <input
            type="range"
            min="0.1"
            max="1.2"
            step="0.05"
            value={settings.ambientIntensity}
            onChange={(e) => onChange({ ...settings, ambientIntensity: parseFloat(e.target.value) })}
            className="flex-1"
          />
          <span className="text-[10px] font-mono w-8 text-right text-[#e5e5e5]">
            {Math.round(settings.ambientIntensity * 100)}%
          </span>
        </div>

        {/* Color Presets */}
        <div className="flex items-center justify-between pt-1">
          <span className="text-[10px] text-[#8a8a8a]">Tint</span>
          <div className="flex items-center space-x-1.5">
            {colorPresets.map((preset) => (
              <button
                key={preset.label}
                type="button"
                onClick={() => onChange({ ...settings, color: preset.color })}
                title={preset.label}
                className={`w-4 h-4 rounded-full border transition-transform cursor-pointer ${
                  settings.color.toLowerCase() === preset.color.toLowerCase()
                    ? 'scale-110 border-[var(--accent)] ring-1 ring-[var(--accent)]'
                    : 'border-white/30 hover:scale-105'
                }`}
                style={{ backgroundColor: preset.color }}
              />
            ))}
          </div>
        </div>
      </div>
    </div>
  );
};
