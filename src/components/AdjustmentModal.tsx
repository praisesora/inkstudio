import React, { useState, useEffect, useRef, useMemo } from 'react';
import { X, RotateCcw, Check, SlidersHorizontal, Trash2 } from 'lucide-react';
import {
  AdjustmentLayerData,
  CurvesAdjustmentData,
  GradientMapAdjustmentData,
  LevelsAdjustmentData,
  ColorBalanceAdjustmentData,
  GradientStop,
  ToneCurvePoints,
} from '../types/editor';
import {
  buildMonotonicCubicSplineLut,
  computeHistogram,
  buildGradientMapLut,
} from '../utils/tonalEngine';

export interface AdjustmentModalProps {
  isOpen: boolean;
  onClose: () => void;
  onApply: (type: 'curves' | 'gradient-map' | 'levels' | 'color-balance', data: AdjustmentLayerData) => void;
  initialType?: 'curves' | 'gradient-map' | 'levels' | 'color-balance';
  initialData?: AdjustmentLayerData;
  editingLayerId?: string | null;
  onPreviewChange?: (data: AdjustmentLayerData | null, enabled: boolean) => void;
  histogramImageData?: ImageData | null;
}

const DEFAULT_CURVES: ToneCurvePoints = {
  rgb: [[0, 0], [255, 255]],
  r: [[0, 0], [255, 255]],
  g: [[0, 0], [255, 255]],
  b: [[0, 0], [255, 255]],
};

const DEFAULT_GRADIENT_STOPS: GradientStop[] = [
  { position: 0, color: '#000000' },
  { position: 1, color: '#ffffff' },
];

const GRADIENT_PRESETS: { name: string; stops: GradientStop[]; interpolation: 'linear' | 'smooth' }[] = [
  {
    name: 'B&W',
    stops: [{ position: 0, color: '#000000' }, { position: 1, color: '#ffffff' }],
    interpolation: 'linear',
  },
  {
    name: 'Sepia',
    stops: [
      { position: 0, color: '#1a0f00' },
      { position: 0.35, color: '#704214' },
      { position: 0.75, color: '#d2b48c' },
      { position: 1, color: '#fffff0' },
    ],
    interpolation: 'smooth',
  },
  {
    name: 'Sunset',
    stops: [
      { position: 0, color: '#0f051d' },
      { position: 0.3, color: '#591a4f' },
      { position: 0.6, color: '#c83e4d' },
      { position: 0.85, color: '#f4b251' },
      { position: 1, color: '#fff1b0' },
    ],
    interpolation: 'smooth',
  },
  {
    name: 'Cyberpunk',
    stops: [
      { position: 0, color: '#03001e' },
      { position: 0.35, color: '#7303c0' },
      { position: 0.75, color: '#ec38bc' },
      { position: 1, color: '#fdeff9' },
    ],
    interpolation: 'smooth',
  },
  {
    name: 'Emerald',
    stops: [
      { position: 0, color: '#051c09' },
      { position: 0.35, color: '#114b1e' },
      { position: 0.7, color: '#2ca048' },
      { position: 1, color: '#9be88b' },
    ],
    interpolation: 'smooth',
  },
  {
    name: 'Inferno',
    stops: [
      { position: 0, color: '#000004' },
      { position: 0.3, color: '#51127c' },
      { position: 0.65, color: '#b73779' },
      { position: 0.9, color: '#fb8861' },
      { position: 1, color: '#fcfdbf' },
    ],
    interpolation: 'smooth',
  },
];

export const AdjustmentModal: React.FC<AdjustmentModalProps> = ({
  isOpen,
  onClose,
  onApply,
  initialType = 'curves',
  initialData,
  editingLayerId,
  onPreviewChange,
  histogramImageData,
}) => {
  const [activeTab, setActiveTab] = useState<'curves' | 'gradient-map' | 'levels' | 'color-balance'>(initialType);
  const [previewEnabled, setPreviewEnabled] = useState(true);

  // Curves State
  const [curves, setCurves] = useState<ToneCurvePoints>(DEFAULT_CURVES);
  const [curveChannel, setCurveChannel] = useState<'rgb' | 'r' | 'g' | 'b'>('rgb');
  const [selectedPointIdx, setSelectedPointIdx] = useState<number | null>(null);

  // Gradient Map State
  const [gradientStops, setGradientStops] = useState<GradientStop[]>(DEFAULT_GRADIENT_STOPS);
  const [gradientInterpolation, setGradientInterpolation] = useState<'linear' | 'smooth'>('smooth');
  const [selectedStopIdx, setSelectedStopIdx] = useState<number>(0);

  // Levels State
  const [levels, setLevels] = useState<{
    blackPoint: number;
    gamma: number;
    whitePoint: number;
    outputMin: number;
    outputMax: number;
    channel: 'rgb' | 'r' | 'g' | 'b';
  }>({
    blackPoint: 0,
    gamma: 1.0,
    whitePoint: 255,
    outputMin: 0,
    outputMax: 255,
    channel: 'rgb',
  });

  // Color Balance State
  const [colorBalance, setColorBalance] = useState<{
    shadows: [number, number, number];
    midtones: [number, number, number];
    highlights: [number, number, number];
    preserveLuminosity: boolean;
  }>({
    shadows: [0, 0, 0],
    midtones: [0, 0, 0],
    highlights: [0, 0, 0],
    preserveLuminosity: true,
  });
  const [cbRange, setCbRange] = useState<'shadows' | 'midtones' | 'highlights'>('midtones');

  // Load initial data
  useEffect(() => {
    if (initialType) {
      setActiveTab(initialType);
    }
    if (initialData) {
      if (initialData.type === 'curves') {
        setCurves(JSON.parse(JSON.stringify(initialData.curves)));
      } else if (initialData.type === 'gradient-map') {
        setGradientStops(JSON.parse(JSON.stringify(initialData.stops)));
        setGradientInterpolation(initialData.interpolation || 'smooth');
      } else if (initialData.type === 'levels') {
        setLevels({
          blackPoint: initialData.blackPoint,
          gamma: initialData.gamma,
          whitePoint: initialData.whitePoint,
          outputMin: initialData.outputMin ?? 0,
          outputMax: initialData.outputMax ?? 255,
          channel: initialData.channel || 'rgb',
        });
      } else if (initialData.type === 'color-balance') {
        setColorBalance({
          shadows: [...initialData.shadows],
          midtones: [...initialData.midtones],
          highlights: [...initialData.highlights],
          preserveLuminosity: initialData.preserveLuminosity ?? true,
        });
      }
    }
  }, [initialType, initialData, isOpen]);

  // Current adjustment data object
  const currentAdjustmentData: AdjustmentLayerData = useMemo(() => {
    switch (activeTab) {
      case 'curves':
        return { type: 'curves', curves } as CurvesAdjustmentData;
      case 'gradient-map':
        return {
          type: 'gradient-map',
          stops: gradientStops,
          interpolation: gradientInterpolation,
        } as GradientMapAdjustmentData;
      case 'levels':
        return {
          type: 'levels',
          ...levels,
        } as LevelsAdjustmentData;
      case 'color-balance':
        return {
          type: 'color-balance',
          ...colorBalance,
        } as ColorBalanceAdjustmentData;
    }
  }, [activeTab, curves, gradientStops, gradientInterpolation, levels, colorBalance]);

  // Notify preview changes
  useEffect(() => {
    if (isOpen && onPreviewChange) {
      onPreviewChange(currentAdjustmentData, previewEnabled);
    }
  }, [currentAdjustmentData, previewEnabled, isOpen, onPreviewChange]);

  // Compute histogram for Tone Curve / Levels background
  const histogramData = useMemo(() => {
    if (!histogramImageData) return null;
    return computeHistogram(histogramImageData, curveChannel);
  }, [histogramImageData, curveChannel]);

  const maxHistogramCount = useMemo(() => {
    if (!histogramData) return 1;
    let max = 1;
    for (let i = 0; i < 256; i++) {
      if (histogramData[i] > max) max = histogramData[i];
    }
    return max;
  }, [histogramData]);

  // Tone Curve calculation for selected channel
  const currentPts = curves[curveChannel];
  const curveLut = useMemo(() => {
    return buildMonotonicCubicSplineLut(currentPts);
  }, [currentPts]);

  // SVG path for active curve
  const curveSvgPath = useMemo(() => {
    let d = `M 0 ${256 - curveLut[0]}`;
    for (let x = 1; x < 256; x++) {
      d += ` L ${x} ${256 - curveLut[x]}`;
    }
    return d;
  }, [curveLut]);

  // Handle Tone Curve control point drag
  const curveSvgRef = useRef<SVGSVGElement | null>(null);
  const [isDraggingPoint, setIsDraggingPoint] = useState(false);

  const handleCurvePointerDown = (e: React.PointerEvent<SVGSVGElement>) => {
    const svg = curveSvgRef.current;
    if (!svg) return;
    const rect = svg.getBoundingClientRect();
    const x = Math.max(0, Math.min(255, Math.round(((e.clientX - rect.left) / rect.width) * 255)));
    const y = Math.max(0, Math.min(255, Math.round((1 - (e.clientY - rect.top) / rect.height) * 255)));

    // Check if clicked near an existing control point
    const pts = curves[curveChannel];
    let clickedIdx = -1;
    for (let i = 0; i < pts.length; i++) {
      const dx = pts[i][0] - x;
      const dy = pts[i][1] - y;
      if (Math.sqrt(dx * dx + dy * dy) < 14) {
        clickedIdx = i;
        break;
      }
    }

    if (clickedIdx >= 0) {
      setSelectedPointIdx(clickedIdx);
      setIsDraggingPoint(true);
      (e.target as Element).setPointerCapture(e.pointerId);
    } else {
      // Add new point
      const newPts = [...pts, [x, y] as [number, number]].sort((a, b) => a[0] - b[0]);
      const newIdx = newPts.findIndex((p) => p[0] === x && p[1] === y);
      setCurves((prev) => ({
        ...prev,
        [curveChannel]: newPts,
      }));
      setSelectedPointIdx(newIdx);
      setIsDraggingPoint(true);
      svg.setPointerCapture(e.pointerId);
    }
  };

  const handleCurvePointerMove = (e: React.PointerEvent<SVGSVGElement>) => {
    if (!isDraggingPoint || selectedPointIdx === null) return;
    const svg = curveSvgRef.current;
    if (!svg) return;
    const rect = svg.getBoundingClientRect();
    let x = Math.max(0, Math.min(255, Math.round(((e.clientX - rect.left) / rect.width) * 255)));
    const y = Math.max(0, Math.min(255, Math.round((1 - (e.clientY - rect.top) / rect.height) * 255)));

    const pts = [...curves[curveChannel]];
    // Lock X coordinate for endpoint 0 and last endpoint
    if (selectedPointIdx === 0) x = 0;
    else if (selectedPointIdx === pts.length - 1) x = 255;
    else {
      // Constrain X between neighbor points
      const minX = pts[selectedPointIdx - 1][0] + 1;
      const maxX = pts[selectedPointIdx + 1][0] - 1;
      x = Math.max(minX, Math.min(maxX, x));
    }

    pts[selectedPointIdx] = [x, y];
    setCurves((prev) => ({
      ...prev,
      [curveChannel]: pts,
    }));
  };

  const handleCurvePointerUp = (e: React.PointerEvent<SVGSVGElement>) => {
    if (isDraggingPoint) {
      setIsDraggingPoint(false);
      try {
        (e.target as Element).releasePointerCapture(e.pointerId);
      } catch (_) {}
    }
  };

  const deleteSelectedCurvePoint = () => {
    if (selectedPointIdx === null) return;
    const pts = curves[curveChannel];
    if (pts.length <= 2) return; // Keep at least 2 points
    if (selectedPointIdx === 0 || selectedPointIdx === pts.length - 1) return; // Don't delete endpoints

    const nextPts = pts.filter((_, i) => i !== selectedPointIdx);
    setCurves((prev) => ({
      ...prev,
      [curveChannel]: nextPts,
    }));
    setSelectedPointIdx(null);
  };

  // Gradient Map Stop Handlers
  const gradientRampRef = useRef<HTMLDivElement | null>(null);
  const [isDraggingStop, setIsDraggingStop] = useState(false);

  const handleRampPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    const ramp = gradientRampRef.current;
    if (!ramp) return;
    const rect = ramp.getBoundingClientRect();
    const pos = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));

    // Sample color from current gradient at this position
    const lut = buildGradientMapLut(gradientStops, gradientInterpolation);
    const lumIdx = Math.round(pos * 255) * 4;
    const r = lut[lumIdx].toString(16).padStart(2, '0');
    const g = lut[lumIdx + 1].toString(16).padStart(2, '0');
    const b = lut[lumIdx + 2].toString(16).padStart(2, '0');
    const newColor = `#${r}${g}${b}`;

    const newStop: GradientStop = { position: Number(pos.toFixed(3)), color: newColor };
    const nextStops = [...gradientStops, newStop].sort((a, b) => a.position - b.position);
    const newIdx = nextStops.findIndex((s) => s.position === newStop.position);
    setGradientStops(nextStops);
    setSelectedStopIdx(newIdx);
  };

  const handleStopPointerDown = (idx: number, e: React.PointerEvent) => {
    e.stopPropagation();
    setSelectedStopIdx(idx);
    setIsDraggingStop(true);
    (e.target as Element).setPointerCapture(e.pointerId);
  };

  const handleStopPointerMove = (e: React.PointerEvent) => {
    if (!isDraggingStop) return;
    const ramp = gradientRampRef.current;
    if (!ramp) return;
    const rect = ramp.getBoundingClientRect();
    const pos = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));

    setGradientStops((prev) => {
      const stops = [...prev];
      stops[selectedStopIdx] = {
        ...stops[selectedStopIdx],
        position: Number(pos.toFixed(3)),
      };
      return stops;
    });
  };

  const handleStopPointerUp = (e: React.PointerEvent) => {
    if (isDraggingStop) {
      setIsDraggingStop(false);
      try {
        (e.target as Element).releasePointerCapture(e.pointerId);
      } catch (_) {}
      // Re-sort stops
      setGradientStops((prev) => [...prev].sort((a, b) => a.position - b.position));
    }
  };

  const deleteSelectedStop = () => {
    if (gradientStops.length <= 2) return;
    setGradientStops((prev) => {
      const next = prev.filter((_, i) => i !== selectedStopIdx);
      return next.sort((a, b) => a.position - b.position);
    });
    setSelectedStopIdx(0);
  };

  const handleResetCurrent = () => {
    if (activeTab === 'curves') {
      setCurves(DEFAULT_CURVES);
      setSelectedPointIdx(null);
    } else if (activeTab === 'gradient-map') {
      setGradientStops(DEFAULT_GRADIENT_STOPS);
      setGradientInterpolation('smooth');
      setSelectedStopIdx(0);
    } else if (activeTab === 'levels') {
      setLevels({
        blackPoint: 0,
        gamma: 1.0,
        whitePoint: 255,
        outputMin: 0,
        outputMax: 255,
        channel: 'rgb',
      });
    } else if (activeTab === 'color-balance') {
      setColorBalance({
        shadows: [0, 0, 0],
        midtones: [0, 0, 0],
        highlights: [0, 0, 0],
        preserveLuminosity: true,
      });
    }
  };

  const handleApply = () => {
    onApply(activeTab, currentAdjustmentData);
    onClose();
  };

  if (!isOpen) return null;

  const channelColor =
    curveChannel === 'r' ? '#ef4444' : curveChannel === 'g' ? '#22c55e' : curveChannel === 'b' ? '#3b82f6' : '#ffffff';

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-xs select-none">
      <div className="bg-[#1c1c1c] border border-[#383838] rounded-lg shadow-2xl w-[480px] max-w-[95vw] overflow-hidden flex flex-col text-[#cccccc] text-xs">
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-[#2d2d2d] bg-[#222222]">
          <div className="flex items-center space-x-2">
            <SlidersHorizontal className="w-4 h-4 text-blue-400" />
            <span className="font-semibold text-white text-sm">
              {editingLayerId ? 'Edit Adjustment Layer' : 'New Adjustment Layer'}
            </span>
          </div>
          <button
            onClick={onClose}
            className="p-1 text-[#888888] hover:text-white rounded hover:bg-[#333333] transition-colors"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Tab Selector */}
        <div className="flex border-b border-[#2d2d2d] bg-[#1e1e1e] p-1 gap-1">
          <button
            onClick={() => setActiveTab('curves')}
            className={`flex-1 py-1.5 px-2 rounded font-medium transition-colors ${
              activeTab === 'curves' ? 'bg-[#2b2b2b] text-white shadow-xs' : 'text-[#888888] hover:text-white'
            }`}
          >
            Tone Curves
          </button>
          <button
            onClick={() => setActiveTab('gradient-map')}
            className={`flex-1 py-1.5 px-2 rounded font-medium transition-colors ${
              activeTab === 'gradient-map' ? 'bg-[#2b2b2b] text-white shadow-xs' : 'text-[#888888] hover:text-white'
            }`}
          >
            Gradient Map
          </button>
          <button
            onClick={() => setActiveTab('levels')}
            className={`flex-1 py-1.5 px-2 rounded font-medium transition-colors ${
              activeTab === 'levels' ? 'bg-[#2b2b2b] text-white shadow-xs' : 'text-[#888888] hover:text-white'
            }`}
          >
            Levels
          </button>
          <button
            onClick={() => setActiveTab('color-balance')}
            className={`flex-1 py-1.5 px-2 rounded font-medium transition-colors ${
              activeTab === 'color-balance' ? 'bg-[#2b2b2b] text-white shadow-xs' : 'text-[#888888] hover:text-white'
            }`}
          >
            Color Balance
          </button>
        </div>

        {/* Body Content */}
        <div className="p-4 space-y-4 max-h-[75vh] overflow-y-auto">
          {/* TAB 1: TONE CURVES */}
          {activeTab === 'curves' && (
            <div className="space-y-3">
              {/* Channel Selector */}
              <div className="flex items-center justify-between">
                <span className="text-xs text-[#888888]">Channel:</span>
                <div className="flex bg-[#161616] rounded p-0.5 border border-[#333333]">
                  {(['rgb', 'r', 'g', 'b'] as const).map((ch) => (
                    <button
                      key={ch}
                      onClick={() => {
                        setCurveChannel(ch);
                        setSelectedPointIdx(null);
                      }}
                      className={`px-3 py-1 rounded text-[11px] font-semibold transition-colors ${
                        curveChannel === ch
                          ? ch === 'r'
                            ? 'bg-red-900/60 text-red-300 ring-1 ring-red-500'
                            : ch === 'g'
                            ? 'bg-green-900/60 text-green-300 ring-1 ring-green-500'
                            : ch === 'b'
                            ? 'bg-blue-900/60 text-blue-300 ring-1 ring-blue-500'
                            : 'bg-[#3a3a3a] text-white'
                          : 'text-[#888888] hover:text-white'
                      }`}
                    >
                      {ch.toUpperCase()}
                    </button>
                  ))}
                </div>
              </div>

              {/* Interactive Curve SVG Grid */}
              <div className="relative w-full aspect-square bg-[#141414] rounded border border-[#333333] overflow-hidden flex items-center justify-center shadow-inner">
                {/* Histogram Overlay */}
                {histogramData && (
                  <svg
                    viewBox="0 0 256 256"
                    className="absolute inset-0 w-full h-full pointer-events-none opacity-25"
                    preserveAspectRatio="none"
                  >
                    {Array.from({ length: 256 }).map((_, i) => {
                      const hVal = (histogramData[i] / maxHistogramCount) * 256;
                      return (
                        <rect
                          key={i}
                          x={i}
                          y={256 - hVal}
                          width={1}
                          height={hVal}
                          fill={channelColor}
                        />
                      );
                    })}
                  </svg>
                )}

                {/* Grid Lines & Labels */}
                <svg
                  ref={curveSvgRef}
                  viewBox="0 0 256 256"
                  className="w-full h-full cursor-crosshair"
                  onPointerDown={handleCurvePointerDown}
                  onPointerMove={handleCurvePointerMove}
                  onPointerUp={handleCurvePointerUp}
                >
                  {/* Grid Lines at 25%, 50%, 75% */}
                  {[64, 128, 192].map((coord) => (
                    <React.Fragment key={coord}>
                      <line x1={coord} y1={0} x2={coord} y2={256} stroke="#2a2a2a" strokeWidth={1} />
                      <line x1={0} y1={coord} x2={256} y2={coord} stroke="#2a2a2a" strokeWidth={1} />
                    </React.Fragment>
                  ))}

                  {/* Diagonal Reference Baseline */}
                  <line x1={0} y1={256} x2={256} y2={0} stroke="#383838" strokeDasharray="3 3" strokeWidth={1} />

                  {/* Curve Path */}
                  <path d={curveSvgPath} fill="none" stroke={channelColor} strokeWidth={2.5} strokeLinecap="round" />

                  {/* Control Points */}
                  {currentPts.map(([px, py], idx) => {
                    const isSelected = selectedPointIdx === idx;
                    return (
                      <g key={idx}>
                        <circle
                          cx={px}
                          cy={256 - py}
                          r={isSelected ? 6 : 4.5}
                          fill={isSelected ? '#3b82f6' : '#ffffff'}
                          stroke="#141414"
                          strokeWidth={2}
                          className="cursor-pointer transition-transform hover:scale-125"
                        />
                      </g>
                    );
                  })}
                </svg>
              </div>

              {/* Point Inspector & Actions */}
              <div className="flex items-center justify-between text-xs pt-1">
                <div className="flex items-center space-x-2">
                  <span className="text-[#888888]">
                    {selectedPointIdx !== null
                      ? `In: ${currentPts[selectedPointIdx][0]}  Out: ${currentPts[selectedPointIdx][1]}`
                      : 'Click curve to add points'}
                  </span>
                </div>
                {selectedPointIdx !== null && selectedPointIdx > 0 && selectedPointIdx < currentPts.length - 1 && (
                  <button
                    onClick={deleteSelectedCurvePoint}
                    className="flex items-center space-x-1 px-2 py-0.5 bg-red-950/40 text-red-400 hover:bg-red-900/60 rounded border border-red-800/40"
                  >
                    <Trash2 className="w-3 h-3" />
                    <span>Delete Point</span>
                  </button>
                )}
              </div>
            </div>
          )}

          {/* TAB 2: GRADIENT MAP */}
          {activeTab === 'gradient-map' && (
            <div className="space-y-4">
              {/* Gradient Preview Bar */}
              <div className="space-y-1.5">
                <div className="flex items-center justify-between text-xs">
                  <span className="text-[#888888]">Color Ramp (Click to add stop):</span>
                  <div className="flex items-center space-x-1 text-[11px]">
                    <span className="text-[#888888]">Blend:</span>
                    <button
                      onClick={() => setGradientInterpolation('linear')}
                      className={`px-1.5 py-0.5 rounded ${
                        gradientInterpolation === 'linear' ? 'bg-[#383838] text-white' : 'text-[#777777]'
                      }`}
                    >
                      Linear
                    </button>
                    <button
                      onClick={() => setGradientInterpolation('smooth')}
                      className={`px-1.5 py-0.5 rounded ${
                        gradientInterpolation === 'smooth' ? 'bg-[#383838] text-white' : 'text-[#777777]'
                      }`}
                    >
                      Smooth
                    </button>
                  </div>
                </div>

                <div
                  ref={gradientRampRef}
                  onClick={handleRampPointerDown}
                  className="relative h-9 rounded border border-[#444444] cursor-pointer shadow-inner overflow-visible"
                  style={{
                    background: `linear-gradient(to right, ${gradientStops
                      .map((s) => `${s.color} ${s.position * 100}%`)
                      .join(', ')})`,
                  }}
                >
                  {/* Draggable Stop Pins */}
                  {gradientStops.map((stop, idx) => {
                    const isSelected = selectedStopIdx === idx;
                    return (
                      <div
                        key={idx}
                        onPointerDown={(e) => handleStopPointerDown(idx, e)}
                        onPointerMove={handleStopPointerMove}
                        onPointerUp={handleStopPointerUp}
                        style={{ left: `${stop.position * 100}%` }}
                        className={`absolute -bottom-3.5 -translate-x-1/2 w-4 h-5 flex flex-col items-center cursor-ew-resize z-20 group`}
                        title={`Stop ${idx + 1}: ${stop.color} (${Math.round(stop.position * 100)}%)`}
                      >
                        <div
                          className={`w-0 h-0 border-l-[4px] border-l-transparent border-r-[4px] border-r-transparent border-b-[5px] ${
                            isSelected ? 'border-b-blue-400' : 'border-b-white'
                          }`}
                        />
                        <div
                          className={`w-3.5 h-3.5 rounded-[2px] border ${
                            isSelected ? 'border-blue-400 ring-2 ring-blue-500/50' : 'border-white'
                          } shadow-md`}
                          style={{ backgroundColor: stop.color }}
                        />
                      </div>
                    );
                  })}
                </div>
              </div>

              {/* Selected Stop Controls */}
              <div className="flex items-center justify-between p-2.5 bg-[#171717] rounded border border-[#2d2d2d] mt-4">
                <div className="flex items-center space-x-3">
                  <div className="flex items-center space-x-1.5">
                    <span className="text-[#888888]">Color:</span>
                    <input
                      type="color"
                      value={gradientStops[selectedStopIdx]?.color || '#ffffff'}
                      onChange={(e) => {
                        const val = e.target.value;
                        setGradientStops((prev) => {
                          const stops = [...prev];
                          stops[selectedStopIdx] = { ...stops[selectedStopIdx], color: val };
                          return stops;
                        });
                      }}
                      className="w-7 h-7 rounded border border-[#444444] bg-transparent cursor-pointer p-0"
                    />
                    <input
                      type="text"
                      value={gradientStops[selectedStopIdx]?.color || ''}
                      onChange={(e) => {
                        const val = e.target.value;
                        setGradientStops((prev) => {
                          const stops = [...prev];
                          stops[selectedStopIdx] = { ...stops[selectedStopIdx], color: val };
                          return stops;
                        });
                      }}
                      className="w-18 bg-[#222222] border border-[#383838] rounded px-1.5 py-0.5 text-xs text-white"
                    />
                  </div>
                  <div className="flex items-center space-x-1">
                    <span className="text-[#888888]">Pos:</span>
                    <span className="text-white font-mono">
                      {Math.round((gradientStops[selectedStopIdx]?.position || 0) * 100)}%
                    </span>
                  </div>
                </div>

                {gradientStops.length > 2 && (
                  <button
                    onClick={deleteSelectedStop}
                    className="p-1 text-[#888888] hover:text-red-400 hover:bg-red-950/30 rounded"
                    title="Delete Stop"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                )}
              </div>

              {/* Preset Ramps */}
              <div className="space-y-1.5">
                <span className="text-[#888888] text-[11px]">Presets:</span>
                <div className="grid grid-cols-3 gap-1.5">
                  {GRADIENT_PRESETS.map((p) => (
                    <button
                      key={p.name}
                      onClick={() => {
                        setGradientStops(JSON.parse(JSON.stringify(p.stops)));
                        setGradientInterpolation(p.interpolation);
                        setSelectedStopIdx(0);
                      }}
                      className="flex items-center space-x-2 p-1.5 rounded bg-[#1e1e1e] hover:bg-[#2a2a2a] border border-[#333333] transition-colors text-left"
                    >
                      <div
                        className="w-5 h-5 rounded-[2px] shrink-0 border border-[#444444]"
                        style={{
                          background: `linear-gradient(to right, ${p.stops
                            .map((s) => `${s.color} ${s.position * 100}%`)
                            .join(', ')})`,
                        }}
                      />
                      <span className="text-[11px] truncate">{p.name}</span>
                    </button>
                  ))}
                </div>
              </div>
            </div>
          )}

          {/* TAB 3: LEVELS */}
          {activeTab === 'levels' && (
            <div className="space-y-3.5">
              <div className="flex items-center justify-between">
                <span className="text-xs text-[#888888]">Channel:</span>
                <div className="flex bg-[#161616] rounded p-0.5 border border-[#333333]">
                  {(['rgb', 'r', 'g', 'b'] as const).map((ch) => (
                    <button
                      key={ch}
                      onClick={() => setLevels((prev) => ({ ...prev, channel: ch }))}
                      className={`px-3 py-1 rounded text-[11px] font-semibold transition-colors ${
                        levels.channel === ch ? 'bg-[#3a3a3a] text-white' : 'text-[#888888] hover:text-white'
                      }`}
                    >
                      {ch.toUpperCase()}
                    </button>
                  ))}
                </div>
              </div>

              {/* Input Black Point Slider */}
              <div className="space-y-1">
                <div className="flex justify-between text-xs">
                  <span className="text-[#888888]">Shadows (Black Point):</span>
                  <span className="font-mono text-white">{levels.blackPoint}</span>
                </div>
                <input
                  type="range"
                  min={0}
                  max={Math.min(253, levels.whitePoint - 1)}
                  value={levels.blackPoint}
                  onChange={(e) => setLevels((prev) => ({ ...prev, blackPoint: Number(e.target.value) }))}
                  className="w-full accent-blue-500"
                />
              </div>

              {/* Gamma Slider */}
              <div className="space-y-1">
                <div className="flex justify-between text-xs">
                  <span className="text-[#888888]">Midtones (Gamma):</span>
                  <span className="font-mono text-white">{levels.gamma.toFixed(2)}</span>
                </div>
                <input
                  type="range"
                  min={0.1}
                  max={5.0}
                  step={0.05}
                  value={levels.gamma}
                  onChange={(e) => setLevels((prev) => ({ ...prev, gamma: Number(e.target.value) }))}
                  className="w-full accent-blue-500"
                />
              </div>

              {/* Input White Point Slider */}
              <div className="space-y-1">
                <div className="flex justify-between text-xs">
                  <span className="text-[#888888]">Highlights (White Point):</span>
                  <span className="font-mono text-white">{levels.whitePoint}</span>
                </div>
                <input
                  type="range"
                  min={Math.max(2, levels.blackPoint + 1)}
                  max={255}
                  value={levels.whitePoint}
                  onChange={(e) => setLevels((prev) => ({ ...prev, whitePoint: Number(e.target.value) }))}
                  className="w-full accent-blue-500"
                />
              </div>

              {/* Output Min / Max */}
              <div className="grid grid-cols-2 gap-3 pt-2 border-t border-[#2d2d2d]">
                <div className="space-y-1">
                  <div className="flex justify-between text-xs">
                    <span className="text-[#888888]">Out Min:</span>
                    <span className="font-mono text-white">{levels.outputMin}</span>
                  </div>
                  <input
                    type="range"
                    min={0}
                    max={255}
                    value={levels.outputMin}
                    onChange={(e) => setLevels((prev) => ({ ...prev, outputMin: Number(e.target.value) }))}
                    className="w-full accent-blue-500"
                  />
                </div>
                <div className="space-y-1">
                  <div className="flex justify-between text-xs">
                    <span className="text-[#888888]">Out Max:</span>
                    <span className="font-mono text-white">{levels.outputMax}</span>
                  </div>
                  <input
                    type="range"
                    min={0}
                    max={255}
                    value={levels.outputMax}
                    onChange={(e) => setLevels((prev) => ({ ...prev, outputMax: Number(e.target.value) }))}
                    className="w-full accent-blue-500"
                  />
                </div>
              </div>
            </div>
          )}

          {/* TAB 4: COLOR BALANCE */}
          {activeTab === 'color-balance' && (
            <div className="space-y-4">
              {/* Range Selector */}
              <div className="flex border border-[#333333] rounded p-0.5 bg-[#161616]">
                {(['shadows', 'midtones', 'highlights'] as const).map((r) => (
                  <button
                    key={r}
                    onClick={() => setCbRange(r)}
                    className={`flex-1 py-1 rounded text-[11px] font-medium capitalize transition-colors ${
                      cbRange === r ? 'bg-[#333333] text-white shadow-xs' : 'text-[#888888] hover:text-white'
                    }`}
                  >
                    {r}
                  </button>
                ))}
              </div>

              {/* Cyan - Red Slider */}
              <div className="space-y-1">
                <div className="flex justify-between text-xs">
                  <span className="text-cyan-400">Cyan</span>
                  <span className="font-mono text-white">{colorBalance[cbRange][0]}</span>
                  <span className="text-red-400">Red</span>
                </div>
                <input
                  type="range"
                  min={-100}
                  max={100}
                  value={colorBalance[cbRange][0]}
                  onChange={(e) => {
                    const val = Number(e.target.value);
                    setColorBalance((prev) => {
                      const arr: [number, number, number] = [...prev[cbRange]];
                      arr[0] = val;
                      return { ...prev, [cbRange]: arr };
                    });
                  }}
                  className="w-full accent-red-500"
                />
              </div>

              {/* Magenta - Green Slider */}
              <div className="space-y-1">
                <div className="flex justify-between text-xs">
                  <span className="text-fuchsia-400">Magenta</span>
                  <span className="font-mono text-white">{colorBalance[cbRange][1]}</span>
                  <span className="text-green-400">Green</span>
                </div>
                <input
                  type="range"
                  min={-100}
                  max={100}
                  value={colorBalance[cbRange][1]}
                  onChange={(e) => {
                    const val = Number(e.target.value);
                    setColorBalance((prev) => {
                      const arr: [number, number, number] = [...prev[cbRange]];
                      arr[1] = val;
                      return { ...prev, [cbRange]: arr };
                    });
                  }}
                  className="w-full accent-green-500"
                />
              </div>

              {/* Yellow - Blue Slider */}
              <div className="space-y-1">
                <div className="flex justify-between text-xs">
                  <span className="text-yellow-400">Yellow</span>
                  <span className="font-mono text-white">{colorBalance[cbRange][2]}</span>
                  <span className="text-blue-400">Blue</span>
                </div>
                <input
                  type="range"
                  min={-100}
                  max={100}
                  value={colorBalance[cbRange][2]}
                  onChange={(e) => {
                    const val = Number(e.target.value);
                    setColorBalance((prev) => {
                      const arr: [number, number, number] = [...prev[cbRange]];
                      arr[2] = val;
                      return { ...prev, [cbRange]: arr };
                    });
                  }}
                  className="w-full accent-blue-500"
                />
              </div>

              {/* Preserve Luminosity Toggle */}
              <label className="flex items-center space-x-2 text-xs text-[#aaaaaa] cursor-pointer pt-1">
                <input
                  type="checkbox"
                  checked={colorBalance.preserveLuminosity}
                  onChange={(e) => setColorBalance((prev) => ({ ...prev, preserveLuminosity: e.target.checked }))}
                  className="rounded bg-[#222222] border-[#444444] text-blue-500"
                />
                <span>Preserve Luminosity</span>
              </label>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between px-4 py-3 border-t border-[#2d2d2d] bg-[#202020]">
          <div className="flex items-center space-x-3">
            <button
              onClick={handleResetCurrent}
              className="flex items-center space-x-1 px-2.5 py-1 text-[#888888] hover:text-white hover:bg-[#333333] rounded transition-colors"
            >
              <RotateCcw className="w-3.5 h-3.5" />
              <span>Reset</span>
            </button>
            <label className="flex items-center space-x-1.5 text-xs text-[#888888] cursor-pointer">
              <input
                type="checkbox"
                checked={previewEnabled}
                onChange={(e) => setPreviewEnabled(e.target.checked)}
                className="rounded bg-[#222222] border-[#444444] text-blue-500"
              />
              <span>Preview</span>
            </label>
          </div>

          <div className="flex items-center space-x-2">
            <button
              onClick={onClose}
              className="px-3 py-1.5 text-xs text-[#aaaaaa] hover:text-white hover:bg-[#333333] rounded transition-colors"
            >
              Cancel
            </button>
            <button
              onClick={handleApply}
              className="flex items-center space-x-1 px-4 py-1.5 text-xs bg-blue-600 hover:bg-blue-500 text-white font-medium rounded shadow-sm transition-colors"
            >
              <Check className="w-3.5 h-3.5" />
              <span>{editingLayerId ? 'Update' : 'Create Layer'}</span>
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};
