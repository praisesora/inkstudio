import React from 'react';

export interface StudioSliderProps {
  label: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  valueLabel?: string;
  onChange: (value: number) => void;
}

export const StudioSlider: React.FC<StudioSliderProps> = ({
  label,
  value,
  min,
  max,
  step = 1,
  valueLabel,
  onChange,
}) => (
  <div className="space-y-1">
    <div className="flex items-center justify-between text-[11px]">
      <span className="text-[#a3a3a3]">{label}</span>
      <span className="font-mono text-[10px] text-[#e5e5e5]">{valueLabel ?? String(value)}</span>
    </div>
    <input
      type="range"
      min={min}
      max={max}
      step={step}
      value={value}
      onChange={(e) => onChange(Number(e.target.value))}
      className="w-full accent-[var(--accent)]"
    />
  </div>
);

export interface StudioToggleProps {
  label: string;
  description?: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
}

export const StudioToggle: React.FC<StudioToggleProps> = ({
  label,
  description,
  checked,
  onChange,
}) => (
  <label className="flex items-center justify-between gap-2 py-1 cursor-pointer select-none">
    <div className="min-w-0">
      <div className="text-[11px] text-[#e5e5e5]">{label}</div>
      {description && <div className="text-[10px] text-[#737373] truncate">{description}</div>}
    </div>
    <input
      type="checkbox"
      checked={checked}
      onChange={(e) => onChange(e.target.checked)}
      className="accent-[var(--accent)] shrink-0"
    />
  </label>
);

export interface StudioSegmentedProps<T extends string> {
  label: string;
  value: T;
  options: Array<{ id: T; label: string }>;
  onChange: (val: T) => void;
}

export function StudioSegmented<T extends string>({
  label,
  value,
  options,
  onChange,
}: StudioSegmentedProps<T>) {
  return (
    <div className="space-y-1">
      <div className="text-[11px] text-[#a3a3a3]">{label}</div>
      <div className="flex flex-wrap gap-1 bg-[#141414] p-1 rounded border border-white/[0.06]">
        {options.map((opt) => (
          <button
            key={opt.id}
            type="button"
            onClick={() => onChange(opt.id)}
            className={`flex-1 min-w-[60px] px-2 py-1 rounded text-[10px] transition-colors cursor-pointer ${
              value === opt.id
                ? 'bg-[#2c2c2c] text-[#f5f5f5] font-medium border border-white/10'
                : 'text-[#8a8a8a] hover:text-[#e5e5e5] hover:bg-white/[0.04]'
            }`}
          >
            {opt.label}
          </button>
        ))}
      </div>
    </div>
  );
}

export function readImageFileAsDataUrl(file: File): Promise<{
  dataUrl: string;
  image: HTMLImageElement;
  width: number;
  height: number;
}> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('Failed to read image file.'));
    reader.onload = () => {
      const dataUrl = String(reader.result || '');
      const img = new Image();
      img.onload = () =>
        resolve({
          dataUrl,
          image: img,
          width: img.naturalWidth || img.width || 128,
          height: img.naturalHeight || img.height || 128,
        });
      img.onerror = () => reject(new Error('Unsupported or corrupted image file.'));
      img.src = dataUrl;
    };
    reader.readAsDataURL(file);
  });
}
