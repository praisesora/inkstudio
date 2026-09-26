import React, { useState, useRef, useEffect, useCallback, useMemo } from 'react';
import {
  ArrowLeftRight,
  Disc,
  Menu,
  Square,
  Play,
  Copy,
  Check,
  ChevronDown,
  ChevronRight,
} from 'lucide-react';
import { ToolType, CanvasColorMode } from '../types/editor';
import {
  hsvToRgb,
  rgbToHsv,
  hexToHsv,
  hsvToHex,
  isValidHex,
  enforceColorMode,
  HSV,
} from '../utils/colorUtils';

export interface ColorWheelProps {
  primaryColor: string;
  secondaryColor: string;
  onPrimaryColorChange: (color: string, commit?: boolean) => void;
  onSecondaryColorChange: (color: string, commit?: boolean) => void;
  onSwapColors: () => void;
  colorMode?: CanvasColorMode;
  currentTool?: ToolType;
  onSelectTool?: (tool: ToolType) => void;
  recentColors?: string[];
  containerWidth?: number;
  activeTarget?: 'primary' | 'secondary';
  onActiveTargetChange?: (target: 'primary' | 'secondary') => void;
  hideHeader?: boolean;
}

// In Clip Studio Paint, Red (H=0) is positioned at 10:30 o'clock (-135 degrees)
const HUE_OFFSET = -135;

export const ColorWheel: React.FC<ColorWheelProps> = ({
  primaryColor,
  secondaryColor,
  onPrimaryColorChange,
  onSecondaryColorChange,
  onSwapColors,
  colorMode = 'color',
  currentTool = 'brush',
  onSelectTool,
  recentColors = [],
  containerWidth = 320,
  activeTarget: controlledActiveTarget,
  onActiveTargetChange,
  hideHeader = false,
}) => {
  // Target swatch being edited: 'primary' or 'secondary'
  const [internalActiveTarget, setInternalActiveTarget] = useState<'primary' | 'secondary'>('primary');
  const activeTarget = controlledActiveTarget ?? internalActiveTarget;

  const setActiveTarget = (target: 'primary' | 'secondary') => {
    if (onActiveTargetChange) {
      onActiveTargetChange(target);
    } else {
      setInternalActiveTarget(target);
    }
  };

  // Wheel inner display mode: 'square' or 'triangle'
  const [wheelMode, setWheelMode] = useState<'square' | 'triangle'>('square');

  // Toggle for expanded RGB / Hex controls
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [copiedHex, setCopiedHex] = useState(false);

  // Active color string
  const activeColor = activeTarget === 'primary' ? primaryColor : secondaryColor;

  // Internal HSV representation to preserve Hue when Saturation or Value is 0
  const [hsv, setHsv] = useState<HSV>(() => {
    const initial = hexToHsv(activeColor);
    return initial;
  });

  // Track dragging state: 'hue' | 'sv' | null
  const [isDragging, setIsDragging] = useState<'hue' | 'sv' | null>(null);
  const isDraggingRef = useRef<'hue' | 'sv' | null>(null);
  isDraggingRef.current = isDragging;

  // Canvas refs
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);

  // Synchronize internal HSV when external activeColor changes (e.g. eye-dropper, palette swap)
  useEffect(() => {
    if (isDraggingRef.current) return; // Don't overwrite while user is actively dragging
    const currentHex = hsvToHex(hsv.h, hsv.s, hsv.v);
    if (currentHex.toLowerCase() !== activeColor.toLowerCase()) {
      const parsed = hexToHsv(activeColor);
      // Preserve hue if activeColor has 0 saturation or 0 value (pure white, black, gray)
      if (parsed.s > 0.02 && parsed.v > 0.02) {
        setHsv(parsed);
      } else {
        setHsv((prev) => ({ h: prev.h, s: parsed.s, v: parsed.v }));
      }
    }
  }, [activeColor]);

  const [measuredWidth, setMeasuredWidth] = useState<number>(containerWidth);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const w = entry.contentRect.width;
        if (w > 0) {
          setMeasuredWidth(Math.round(w));
        }
      }
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Dynamically compute canvas diameter to fit sidebar neatly
  const effectiveWidth = measuredWidth || containerWidth;
  const wheelSize = useMemo(() => {
    const pad = 28;
    const available = effectiveWidth > 0 ? effectiveWidth - pad : 250;
    return Math.max(180, Math.min(270, available));
  }, [effectiveWidth]);

  // Dimensions & radiuses
  const cx = wheelSize / 2;
  const cy = wheelSize / 2;
  const outerRadius = wheelSize / 2 - 8;
  const ringThickness = Math.max(18, Math.round(wheelSize * 0.088));
  const innerRadius = outerRadius - ringThickness;
  const squareSize = Math.floor((innerRadius - 10) * Math.SQRT2);
  const sqX = cx - squareSize / 2;
  const sqY = cy - squareSize / 2;

  // Emit color updates to parent
  const handleColorChange = useCallback(
    (newHsv: HSV, commitToRecent = false) => {
      setHsv(newHsv);
      let hex = hsvToHex(newHsv.h, newHsv.s, newHsv.v);
      if (colorMode && colorMode !== 'color') {
        hex = enforceColorMode(hex, colorMode);
      }
      if (activeTarget === 'primary') {
        onPrimaryColorChange(hex, commitToRecent);
      } else {
        onSecondaryColorChange(hex, commitToRecent);
      }
    },
    [activeTarget, colorMode, onPrimaryColorChange, onSecondaryColorChange]
  );

  // Draw the entire color wheel (Outer Hue Ring + Inner SV Box)
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const dpr = window.devicePixelRatio || 1;
    canvas.width = wheelSize * dpr;
    canvas.height = wheelSize * dpr;
    ctx.resetTransform();
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, wheelSize, wheelSize);

    // 1. Draw Outer Hue Ring using Conic Gradient
    ctx.save();
    const angleRad = (HUE_OFFSET * Math.PI) / 180;
    const conic = ctx.createConicGradient(angleRad, cx, cy);
    conic.addColorStop(0 / 6, '#ff0000');
    conic.addColorStop(1 / 6, '#ffff00');
    conic.addColorStop(2 / 6, '#00ff00');
    conic.addColorStop(3 / 6, '#00ffff');
    conic.addColorStop(4 / 6, '#0000ff');
    conic.addColorStop(5 / 6, '#ff00ff');
    conic.addColorStop(1, '#ff0000');

    ctx.beginPath();
    ctx.arc(cx, cy, outerRadius, 0, Math.PI * 2);
    ctx.arc(cx, cy, innerRadius, 0, Math.PI * 2, true);
    ctx.closePath();
    ctx.fillStyle = conic;
    ctx.fill();

    // Ring borders
    ctx.strokeStyle = '#1b1b1b';
    ctx.lineWidth = 1;
    ctx.stroke();

    ctx.beginPath();
    ctx.arc(cx, cy, outerRadius, 0, Math.PI * 2);
    ctx.strokeStyle = '#38383a';
    ctx.lineWidth = 0.75;
    ctx.stroke();

    ctx.beginPath();
    ctx.arc(cx, cy, innerRadius, 0, Math.PI * 2);
    ctx.strokeStyle = '#38383a';
    ctx.lineWidth = 0.75;
    ctx.stroke();
    ctx.restore();

    // 2. Draw Outer Hue Ring Indicator Handle (Clip Studio Paint style rectangular frame)
    ctx.save();
    const hueAngle = ((hsv.h + HUE_OFFSET) * Math.PI) / 180;
    ctx.translate(cx, cy);
    ctx.rotate(hueAngle);

    const midRadius = (outerRadius + innerRadius) / 2;
    const indicatorSpan = ringThickness + 6;
    const indicatorWidth = 10;
    const indX = midRadius - indicatorSpan / 2;
    const indY = -indicatorWidth / 2;

    // Outer white border
    ctx.beginPath();
    ctx.rect(indX, indY, indicatorSpan, indicatorWidth);
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 2;
    ctx.stroke();

    // Inner dark contrast border
    ctx.beginPath();
    ctx.rect(indX + 1, indY + 1, indicatorSpan - 2, indicatorWidth - 2);
    ctx.strokeStyle = '#000000';
    ctx.lineWidth = 1;
    ctx.stroke();

    ctx.restore();

    // 3. Draw Inner Area: Square or Triangle
    if (wheelMode === 'square') {
      // 3A: SV Square Mode
      ctx.save();
      // Base pure hue background
      const pureRgb = hsvToRgb(hsv.h, 1, 1);
      ctx.fillStyle = `rgb(${pureRgb.r}, ${pureRgb.g}, ${pureRgb.b})`;
      ctx.fillRect(sqX, sqY, squareSize, squareSize);

      // Horizontal gradient: Pure White on left -> Transparent on right
      const gradWhite = ctx.createLinearGradient(sqX, sqY, sqX + squareSize, sqY);
      gradWhite.addColorStop(0, 'rgba(255, 255, 255, 1)');
      gradWhite.addColorStop(1, 'rgba(255, 255, 255, 0)');
      ctx.fillStyle = gradWhite;
      ctx.fillRect(sqX, sqY, squareSize, squareSize);

      // Vertical gradient: Transparent on top -> Pure Black on bottom
      const gradBlack = ctx.createLinearGradient(sqX, sqY, sqX, sqY + squareSize);
      gradBlack.addColorStop(0, 'rgba(0, 0, 0, 0)');
      gradBlack.addColorStop(1, 'rgba(0, 0, 0, 1)');
      ctx.fillStyle = gradBlack;
      ctx.fillRect(sqX, sqY, squareSize, squareSize);

      // Square dark border
      ctx.strokeStyle = '#1a1a1a';
      ctx.lineWidth = 1;
      ctx.strokeRect(sqX, sqY, squareSize, squareSize);

      // 4A: SV Square Cursor
      const curX = sqX + hsv.s * squareSize;
      const curY = sqY + (1 - hsv.v) * squareSize;

      // Double ring for 100% visibility over any color
      ctx.beginPath();
      ctx.arc(curX, curY, 5.5, 0, Math.PI * 2);
      ctx.strokeStyle = '#000000';
      ctx.lineWidth = 2.5;
      ctx.stroke();

      ctx.beginPath();
      ctx.arc(curX, curY, 5.5, 0, Math.PI * 2);
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = 1.5;
      ctx.stroke();

      ctx.restore();
    } else {
      // 3B: SV Triangle Mode (Tip pointing towards current Hue angle)
      ctx.save();
      const tipAngle = ((hsv.h + HUE_OFFSET) * Math.PI) / 180;
      const rTri = innerRadius - 8;

      const pTip = { x: cx + rTri * Math.cos(tipAngle), y: cy + rTri * Math.sin(tipAngle) };
      const pWhite = {
        x: cx + rTri * Math.cos(tipAngle + (2 * Math.PI) / 3),
        y: cy + rTri * Math.sin(tipAngle + (2 * Math.PI) / 3),
      };
      const pBlack = {
        x: cx + rTri * Math.cos(tipAngle - (2 * Math.PI) / 3),
        y: cy + rTri * Math.sin(tipAngle - (2 * Math.PI) / 3),
      };

      // Clip inside triangle
      ctx.beginPath();
      ctx.moveTo(pTip.x, pTip.y);
      ctx.lineTo(pWhite.x, pWhite.y);
      ctx.lineTo(pBlack.x, pBlack.y);
      ctx.closePath();
      ctx.save();
      ctx.clip();

      // Pure hue fill
      const pureRgb = hsvToRgb(hsv.h, 1, 1);
      ctx.fillStyle = `rgb(${pureRgb.r}, ${pureRgb.g}, ${pureRgb.b})`;
      ctx.fill();

      // Gradient from White vertex to opposite edge
      const gradWhite = ctx.createLinearGradient(
        pWhite.x,
        pWhite.y,
        (pTip.x + pBlack.x) / 2,
        (pTip.y + pBlack.y) / 2
      );
      gradWhite.addColorStop(0, 'rgba(255, 255, 255, 1)');
      gradWhite.addColorStop(1, 'rgba(255, 255, 255, 0)');
      ctx.fillStyle = gradWhite;
      ctx.fill();

      // Gradient from Black vertex to opposite edge
      const gradBlack = ctx.createLinearGradient(
        pBlack.x,
        pBlack.y,
        (pTip.x + pWhite.x) / 2,
        (pTip.y + pWhite.y) / 2
      );
      gradBlack.addColorStop(0, 'rgba(0, 0, 0, 1)');
      gradBlack.addColorStop(1, 'rgba(0, 0, 0, 0)');
      ctx.fillStyle = gradBlack;
      ctx.fill();

      ctx.restore(); // unclip

      // Triangle border
      ctx.beginPath();
      ctx.moveTo(pTip.x, pTip.y);
      ctx.lineTo(pWhite.x, pWhite.y);
      ctx.lineTo(pBlack.x, pBlack.y);
      ctx.closePath();
      ctx.strokeStyle = '#222222';
      ctx.lineWidth = 1;
      ctx.stroke();

      // 4B: Triangle Cursor using Barycentric coordinates
      const wA = hsv.s * hsv.v; // Pure Hue weight
      const wB = (1 - hsv.s) * hsv.v; // White weight
      const wC = 1 - hsv.v; // Black weight
      const curX = wA * pTip.x + wB * pWhite.x + wC * pBlack.x;
      const curY = wA * pTip.y + wB * pWhite.y + wC * pBlack.y;

      ctx.beginPath();
      ctx.arc(curX, curY, 5.5, 0, Math.PI * 2);
      ctx.strokeStyle = '#000000';
      ctx.lineWidth = 2.5;
      ctx.stroke();

      ctx.beginPath();
      ctx.arc(curX, curY, 5.5, 0, Math.PI * 2);
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = 1.5;
      ctx.stroke();

      ctx.restore();
    }
  }, [cx, cy, outerRadius, innerRadius, ringThickness, sqX, sqY, squareSize, wheelSize, hsv, wheelMode]);

  // Pointer Interaction Handlers
  const handlePointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    e.preventDefault();
    canvas.setPointerCapture(e.pointerId);

    const rect = canvas.getBoundingClientRect();
    const px = e.clientX - rect.left;
    const py = e.clientY - rect.top;

    const dx = px - cx;
    const dy = py - cy;
    const dist = Math.hypot(dx, dy);

    // Click on Outer Hue Ring
    if (dist >= innerRadius - 5 && dist <= outerRadius + 8) {
      setIsDragging('hue');
      const angle = Math.atan2(dy, dx);
      const deg = (angle * 180) / Math.PI;
      let newHue = Math.round((deg - HUE_OFFSET + 360) % 360);
      handleColorChange({ ...hsv, h: newHue }, false);
      return;
    }

    // Click in Inner Area (zero dead zone)
    if (dist < innerRadius - 5) {
      setIsDragging('sv');
      if (wheelMode === 'square') {
        const s = Math.max(0, Math.min(1, (px - sqX) / squareSize));
        const v = Math.max(0, Math.min(1, 1 - (py - sqY) / squareSize));
        handleColorChange({ ...hsv, s, v }, false);
      } else {
        // Triangle Mode
        const rTri = innerRadius - 8;
        const tipAngle = ((hsv.h + HUE_OFFSET) * Math.PI) / 180;
        const pTip = { x: cx + rTri * Math.cos(tipAngle), y: cy + rTri * Math.sin(tipAngle) };
        const pWhite = {
          x: cx + rTri * Math.cos(tipAngle + (2 * Math.PI) / 3),
          y: cy + rTri * Math.sin(tipAngle + (2 * Math.PI) / 3),
        };
        const pBlack = {
          x: cx + rTri * Math.cos(tipAngle - (2 * Math.PI) / 3),
          y: cy + rTri * Math.sin(tipAngle - (2 * Math.PI) / 3),
        };

        // Barycentric coordinate calculation for point P
        const det =
          (pWhite.y - pBlack.y) * (pTip.x - pBlack.x) +
          (pBlack.x - pWhite.x) * (pTip.y - pBlack.y);
        let wA =
          ((pWhite.y - pBlack.y) * (px - pBlack.x) + (pBlack.x - pWhite.x) * (py - pBlack.y)) / det;
        let wB =
          ((pBlack.y - pTip.y) * (px - pBlack.x) + (pTip.x - pBlack.x) * (py - pBlack.y)) / det;
        let wC = 1 - wA - wB;

        // Clamp inside triangle
        wA = Math.max(0, Math.min(1, wA));
        wB = Math.max(0, Math.min(1, wB));
        wC = Math.max(0, Math.min(1, wC));
        const sum = wA + wB + wC;
        if (sum > 0) {
          wA /= sum;
          wB /= sum;
          wC /= sum;
        }

        const v = Math.max(0, Math.min(1, 1 - wC));
        const s = v > 0.001 ? Math.max(0, Math.min(1, wA / v)) : 0;
        handleColorChange({ ...hsv, s, v }, false);
      }
    }
  };

  const handlePointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!isDragging) return;
    const canvas = canvasRef.current;
    if (!canvas) return;

    const rect = canvas.getBoundingClientRect();
    const px = e.clientX - rect.left;
    const py = e.clientY - rect.top;

    if (isDragging === 'hue') {
      const dx = px - cx;
      const dy = py - cy;
      const angle = Math.atan2(dy, dx);
      const deg = (angle * 180) / Math.PI;
      let newHue = Math.round((deg - HUE_OFFSET + 360) % 360);
      handleColorChange({ ...hsv, h: newHue }, false);
    } else if (isDragging === 'sv') {
      if (wheelMode === 'square') {
        const s = Math.max(0, Math.min(1, (px - sqX) / squareSize));
        const v = Math.max(0, Math.min(1, 1 - (py - sqY) / squareSize));
        handleColorChange({ ...hsv, s, v }, false);
      } else {
        const rTri = innerRadius - 8;
        const tipAngle = ((hsv.h + HUE_OFFSET) * Math.PI) / 180;
        const pTip = { x: cx + rTri * Math.cos(tipAngle), y: cy + rTri * Math.sin(tipAngle) };
        const pWhite = {
          x: cx + rTri * Math.cos(tipAngle + (2 * Math.PI) / 3),
          y: cy + rTri * Math.sin(tipAngle + (2 * Math.PI) / 3),
        };
        const pBlack = {
          x: cx + rTri * Math.cos(tipAngle - (2 * Math.PI) / 3),
          y: cy + rTri * Math.sin(tipAngle - (2 * Math.PI) / 3),
        };

        const det =
          (pWhite.y - pBlack.y) * (pTip.x - pBlack.x) +
          (pBlack.x - pWhite.x) * (pTip.y - pBlack.y);
        let wA =
          ((pWhite.y - pBlack.y) * (px - pBlack.x) + (pBlack.x - pWhite.x) * (py - pBlack.y)) / det;
        let wB =
          ((pBlack.y - pTip.y) * (px - pBlack.x) + (pTip.x - pBlack.x) * (py - pBlack.y)) / det;
        let wC = 1 - wA - wB;

        wA = Math.max(0, Math.min(1, wA));
        wB = Math.max(0, Math.min(1, wB));
        wC = Math.max(0, Math.min(1, wC));
        const sum = wA + wB + wC;
        if (sum > 0) {
          wA /= sum;
          wB /= sum;
          wC /= sum;
        }

        const v = Math.max(0, Math.min(1, 1 - wC));
        const s = v > 0.001 ? Math.max(0, Math.min(1, wA / v)) : 0;
        handleColorChange({ ...hsv, s, v });
      }
    }
  };

  const handlePointerUp = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!isDragging) return;
    const canvas = canvasRef.current;
    if (canvas && canvas.hasPointerCapture(e.pointerId)) {
      canvas.releasePointerCapture(e.pointerId);
    }
    setIsDragging(null);
    // Commit final color
    handleColorChange(hsv, true);
  };

  // Direct HSV Numeric Inputs Handlers
  const handleHueInput = (valStr: string) => {
    const val = parseInt(valStr, 10);
    if (!isNaN(val)) {
      const clamped = Math.max(0, Math.min(359, val));
      handleColorChange({ ...hsv, h: clamped }, true);
    }
  };

  const handleSatInput = (valStr: string) => {
    const val = parseInt(valStr, 10);
    if (!isNaN(val)) {
      const clamped = Math.max(0, Math.min(100, val)) / 100;
      handleColorChange({ ...hsv, s: clamped }, true);
    }
  };

  const handleValInput = (valStr: string) => {
    const val = parseInt(valStr, 10);
    if (!isNaN(val)) {
      const clamped = Math.max(0, Math.min(100, val)) / 100;
      handleColorChange({ ...hsv, v: clamped }, true);
    }
  };

  // Direct Hex Input Handler
  const handleHexInput = (valStr: string) => {
    const trimmed = valStr.trim();
    if (isValidHex(trimmed)) {
      const formatted = trimmed.startsWith('#') ? trimmed : `#${trimmed}`;
      const newHsv = hexToHsv(formatted);
      handleColorChange(newHsv, true);
    }
  };

  // Direct RGB Input Handlers
  const currentRgb = useMemo(() => hsvToRgb(hsv.h, hsv.s, hsv.v), [hsv]);

  const handleRgbInput = (channel: 'r' | 'g' | 'b', valStr: string) => {
    const val = parseInt(valStr, 10);
    if (!isNaN(val)) {
      const clamped = Math.max(0, Math.min(255, val));
      const nextRgb = { ...currentRgb, [channel]: clamped };
      const nextHsv = rgbToHsv(nextRgb.r, nextRgb.g, nextRgb.b);
      handleColorChange(nextHsv, true);
    }
  };

  const copyHexToClipboard = () => {
    navigator.clipboard.writeText(activeColor.toUpperCase());
    setCopiedHex(true);
    setTimeout(() => setCopiedHex(false), 1500);
  };

  // Transparent Color Toggle (CSP checkered button)
  const isTransparentActive = currentTool === 'eraser';
  const handleToggleTransparent = () => {
    if (onSelectTool) {
      if (isTransparentActive) {
        onSelectTool('brush');
      } else {
        onSelectTool('eraser');
      }
    }
  };

  return (
    <div ref={containerRef} className="flex flex-col select-none text-[#cccccc] text-xs">
      {/* Header Bar matching Clip Studio Paint Color Wheel */}
      {!hideHeader && (
        <div className="bg-[#2a2a2a] px-3 py-1.5 border-b border-[#333333] flex items-center justify-between">
          <div className="flex items-center space-x-2 text-xs font-medium text-[#cccccc]">
            <Menu className="w-3.5 h-3.5 text-[#888888] cursor-pointer hover:text-white transition-colors" />
            <div className="flex items-center space-x-1.5">
              <Disc className="w-3.5 h-3.5 text-[#5ce1e6]" />
              <span className="font-semibold tracking-wide">Color Wheel</span>
            </div>
          </div>

          <div className="flex items-center space-x-1">
            {/* Swap Colors Shortcut Button */}
            <button
              onClick={onSwapColors}
              title="Swap Primary & Secondary Colors (X)"
              className="flex items-center space-x-1 px-1.5 py-0.5 bg-[#1e1e1e] hover:bg-[#333333] text-[#888888] hover:text-[#cccccc] rounded-[2px] border border-[#3a3a3a] transition-colors cursor-pointer"
            >
              <ArrowLeftRight className="w-3 h-3" />
              <span className="text-[10px] font-mono">X</span>
            </button>
          </div>
        </div>
      )}

      {/* Main Wheel Canvas Section */}
      <div className="flex flex-col items-center justify-center pt-2.5 pb-1 px-3">
        <div
          style={{ width: wheelSize, height: wheelSize }}
          className="relative flex items-center justify-center cursor-crosshair touch-none"
        >
          <canvas
            ref={canvasRef}
            style={{ width: wheelSize, height: wheelSize }}
            onPointerDown={handlePointerDown}
            onPointerMove={handlePointerMove}
            onPointerUp={handlePointerUp}
            onPointerCancel={handlePointerUp}
            className="block"
          />
        </div>

        {/* Clip Studio Paint Bottom Controls: Dual Swatches + Transparent Swatch + H S V Readout + Mode Toggle */}
        <div
          style={{ width: wheelSize }}
          className="flex items-center justify-between mt-1 px-1 pt-1 pb-1"
        >
          {/* Left: Dual Primary/Secondary Swatches & Transparent Checker Button */}
          <div className="flex items-center space-x-2">
            {/* Overlapping Primary / Secondary Swatches */}
            <div className="relative w-8 h-8 shrink-0">
              {/* Secondary Color Swatch (bottom-right) */}
              <div
                onClick={() => {
                  setActiveTarget('secondary');
                  if (currentTool === 'eraser' && onSelectTool) onSelectTool('brush');
                }}
                title={`Secondary Color: ${secondaryColor} (Click to select & edit)`}
                className={`absolute bottom-0 right-0 w-5 h-5 rounded-[2px] cursor-pointer transition-all ${
                  activeTarget === 'secondary' && !isTransparentActive
                    ? 'border-2 border-[#5ce1e6] ring-2 ring-[#5ce1e6]/40 shadow-sm z-10 scale-105'
                    : 'border border-[#555555] hover:border-white z-0'
                }`}
                style={{ backgroundColor: secondaryColor }}
              />

              {/* Primary Color Swatch (top-left) */}
              <div
                onClick={() => {
                  setActiveTarget('primary');
                  if (currentTool === 'eraser' && onSelectTool) onSelectTool('brush');
                }}
                title={`Primary Color: ${primaryColor} (Click to select & edit)`}
                className={`absolute top-0 left-0 w-5 h-5 rounded-[2px] cursor-pointer transition-all ${
                  activeTarget === 'primary' && !isTransparentActive
                    ? 'border-2 border-[#5ce1e6] ring-2 ring-[#5ce1e6]/40 shadow-md z-10 scale-105'
                    : 'border border-white/80 hover:border-white z-0'
                }`}
                style={{ backgroundColor: primaryColor }}
              />
            </div>

            {/* Transparent Color Button (CSP checkered swatch) */}
            <button
              onClick={handleToggleTransparent}
              title="Transparent Color / Eraser Mode (C)"
              className={`w-6 h-5 rounded-[2px] overflow-hidden border cursor-pointer transition-all relative ${
                isTransparentActive
                  ? 'border-[#5ce1e6] ring-2 ring-[#5ce1e6]/40 scale-105'
                  : 'border-[#444444] hover:border-[#888888]'
              }`}
              style={{
                backgroundImage:
                  'repeating-conic-gradient(#555555 0% 25%, #333333 0% 50%)',
                backgroundSize: '8px 8px',
              }}
            />
          </div>

          {/* Center: Numeric H, S, V Readout / Inputs (matching screenshot `H 0 S 1 V 0`) */}
          <div className="flex items-center space-x-1.5 text-[11px] font-mono text-[#aaaaaa]">
            {/* Hue */}
            <div className="flex items-center space-x-0.5">
              <span className="text-[#888888] font-sans text-[10px] font-semibold">H</span>
              <input
                type="number"
                min={0}
                max={359}
                value={Math.round(hsv.h)}
                onChange={(e) => handleHueInput(e.target.value)}
                className="w-8 bg-[#1e1e1e] border border-[#333333] hover:border-[#555555] focus:border-[#5ce1e6] rounded-[2px] px-0.5 py-0.5 text-center text-[#dddddd] text-[10px] outline-none [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
              />
            </div>

            {/* Saturation */}
            <div className="flex items-center space-x-0.5">
              <span className="text-[#888888] font-sans text-[10px] font-semibold">S</span>
              <input
                type="number"
                min={0}
                max={100}
                value={Math.round(hsv.s * 100)}
                onChange={(e) => handleSatInput(e.target.value)}
                className="w-8 bg-[#1e1e1e] border border-[#333333] hover:border-[#555555] focus:border-[#5ce1e6] rounded-[2px] px-0.5 py-0.5 text-center text-[#dddddd] text-[10px] outline-none [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
              />
            </div>

            {/* Value */}
            <div className="flex items-center space-x-0.5">
              <span className="text-[#888888] font-sans text-[10px] font-semibold">V</span>
              <input
                type="number"
                min={0}
                max={100}
                value={Math.round(hsv.v * 100)}
                onChange={(e) => handleValInput(e.target.value)}
                className="w-8 bg-[#1e1e1e] border border-[#333333] hover:border-[#555555] focus:border-[#5ce1e6] rounded-[2px] px-0.5 py-0.5 text-center text-[#dddddd] text-[10px] outline-none [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
              />
            </div>
          </div>

          {/* Right: Wheel Mode Toggle (Square vs Triangle, matching bottom-right circular button in screenshot) */}
          <button
            onClick={() => setWheelMode((m) => (m === 'square' ? 'triangle' : 'square'))}
            title={`Switch to ${wheelMode === 'square' ? 'Triangle' : 'Square'} Color Wheel`}
            className="w-6 h-6 rounded-full bg-[#1e1e1e] border border-[#3a3a3a] hover:border-[#666666] flex items-center justify-center text-[#888888] hover:text-[#5ce1e6] transition-colors cursor-pointer"
          >
            {wheelMode === 'square' ? (
              <Play className="w-3 h-3 rotate-90 fill-current" />
            ) : (
              <Square className="w-2.5 h-2.5" />
            )}
          </button>
        </div>
      </div>

      {/* Hex Code & Quick Toggle Strip */}
      <div className="px-3 pb-2 pt-0.5 space-y-2">
        <div className="flex items-center space-x-2">
          {/* Active Hex Input */}
          <div className="relative flex-1 flex items-center">
            <span className="absolute left-2 text-[#777777] font-mono text-[11px]">#</span>
            <input
              type="text"
              value={activeColor.replace('#', '').toUpperCase()}
              onChange={(e) => handleHexInput(e.target.value)}
              className="w-full bg-[#1e1e1e] border border-[#333333] focus:border-[#5ce1e6] rounded-[2px] pl-5 pr-7 py-1 text-[#dddddd] font-mono text-xs outline-none"
              maxLength={6}
              placeholder="000000"
            />
            <button
              onClick={copyHexToClipboard}
              title="Copy Hex Code"
              className="absolute right-1.5 p-1 text-[#777777] hover:text-white rounded transition-colors"
            >
              {copiedHex ? (
                <Check className="w-3 h-3 text-emerald-400" />
              ) : (
                <Copy className="w-3 h-3" />
              )}
            </button>
          </div>

          {/* Toggle RGB Sliders */}
          <button
            onClick={() => setShowAdvanced((v) => !v)}
            title="Toggle RGB / Advanced Inputs"
            className={`px-2 py-1 rounded-[2px] border text-[10px] font-medium transition-colors flex items-center space-x-1 cursor-pointer ${
              showAdvanced
                ? 'bg-[#2b353a] text-[#5ce1e6] border-[#3e535e]'
                : 'bg-[#1e1e1e] text-[#888888] hover:text-[#cccccc] border-[#333333]'
            }`}
          >
            <span>RGB</span>
            {showAdvanced ? (
              <ChevronDown className="w-3 h-3" />
            ) : (
              <ChevronRight className="w-3 h-3" />
            )}
          </button>
        </div>

        {/* Collapsible RGB Channels */}
        {showAdvanced && (
          <div className="bg-[#1a1a1c] p-2 rounded-[2px] border border-[#2d2d30] space-y-1.5 animate-in fade-in duration-150">
            {/* R */}
            <div className="flex items-center space-x-2">
              <span className="w-3 text-[10px] font-bold text-rose-400">R</span>
              <input
                type="range"
                min={0}
                max={255}
                value={currentRgb.r}
                onChange={(e) => handleRgbInput('r', e.target.value)}
                className="flex-1 h-1 bg-[#333333] rounded appearance-none cursor-pointer accent-rose-500"
              />
              <input
                type="number"
                min={0}
                max={255}
                value={currentRgb.r}
                onChange={(e) => handleRgbInput('r', e.target.value)}
                className="w-10 bg-[#222224] border border-[#333333] rounded px-1 py-0.5 text-center font-mono text-[10px] text-[#cccccc] outline-none"
              />
            </div>

            {/* G */}
            <div className="flex items-center space-x-2">
              <span className="w-3 text-[10px] font-bold text-emerald-400">G</span>
              <input
                type="range"
                min={0}
                max={255}
                value={currentRgb.g}
                onChange={(e) => handleRgbInput('g', e.target.value)}
                className="flex-1 h-1 bg-[#333333] rounded appearance-none cursor-pointer accent-emerald-500"
              />
              <input
                type="number"
                min={0}
                max={255}
                value={currentRgb.g}
                onChange={(e) => handleRgbInput('g', e.target.value)}
                className="w-10 bg-[#222224] border border-[#333333] rounded px-1 py-0.5 text-center font-mono text-[10px] text-[#cccccc] outline-none"
              />
            </div>

            {/* B */}
            <div className="flex items-center space-x-2">
              <span className="w-3 text-[10px] font-bold text-blue-400">B</span>
              <input
                type="range"
                min={0}
                max={255}
                value={currentRgb.b}
                onChange={(e) => handleRgbInput('b', e.target.value)}
                className="flex-1 h-1 bg-[#333333] rounded appearance-none cursor-pointer accent-blue-500"
              />
              <input
                type="number"
                min={0}
                max={255}
                value={currentRgb.b}
                onChange={(e) => handleRgbInput('b', e.target.value)}
                className="w-10 bg-[#222224] border border-[#333333] rounded px-1 py-0.5 text-center font-mono text-[10px] text-[#cccccc] outline-none"
              />
            </div>
          </div>
        )}

        {/* Recent Color History Swatches */}
        {recentColors && recentColors.length > 0 && (
          <div className="pt-1.5 border-t border-[#2e2e30]">
            <div className="flex items-center justify-between text-[10px] text-[#777777] mb-1 font-medium">
              <span>Recent Colors</span>
              <span className="text-[9px] text-[#555555]">{recentColors.length} items</span>
            </div>
            <div className="flex items-center space-x-1 overflow-x-auto py-0.5 scrollbar-thin">
              {recentColors.map((color, idx) => (
                <button
                  key={`${color}-${idx}`}
                  onClick={() => {
                    if (activeTarget === 'primary') {
                      onPrimaryColorChange(color);
                    } else {
                      onSecondaryColorChange(color);
                    }
                  }}
                  title={`Recent: ${color}`}
                  className={`w-5 h-5 rounded-[2px] border shrink-0 cursor-pointer transition-transform hover:scale-110 ${
                    activeColor.toLowerCase() === color.toLowerCase()
                      ? 'border-white ring-1 ring-[#5ce1e6]'
                      : 'border-[#383838] hover:border-[#777777]'
                  }`}
                  style={{ backgroundColor: color }}
                />
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
};
