import React, { useState, useRef, useEffect, useCallback, useMemo } from 'react';
import { Play, Square } from 'lucide-react';
import { ToolType, CanvasColorMode } from '../types/editor';
import {
  hsvToRgb,
  hexToHsv,
  hsvToHex,
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
  containerHeight?: number;
  activeTarget?: 'primary' | 'secondary';
  onActiveTargetChange?: (target: 'primary' | 'secondary') => void;
  hideHeader?: boolean;
}

const HUE_OFFSET = -135;

export const ColorWheel: React.FC<ColorWheelProps> = ({
  primaryColor,
  secondaryColor,
  onPrimaryColorChange,
  onSecondaryColorChange,
  colorMode = 'color',
  containerWidth = 180,
  containerHeight,
  activeTarget: controlledActiveTarget,
}) => {
  const activeTarget = controlledActiveTarget ?? 'primary';
  const [wheelMode, setWheelMode] = useState<'square' | 'triangle'>('square');
  const activeColor = activeTarget === 'primary' ? primaryColor : secondaryColor;

  const [hsv, setHsv] = useState<HSV>(() => hexToHsv(activeColor));
  const [isDragging, setIsDragging] = useState<'hue' | 'sv' | null>(null);
  const isDraggingRef = useRef<'hue' | 'sv' | null>(null);
  isDraggingRef.current = isDragging;

  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (isDraggingRef.current) return;
    const currentHex = hsvToHex(hsv.h, hsv.s, hsv.v);
    if (currentHex.toLowerCase() !== activeColor.toLowerCase()) {
      const parsed = hexToHsv(activeColor);
      if (parsed.s > 0.02 && parsed.v > 0.02) {
        setHsv(parsed);
      } else {
        setHsv((prev) => ({ h: prev.h, s: parsed.s, v: parsed.v }));
      }
    }
  }, [activeColor, hsv.h, hsv.s, hsv.v]);

  const [measuredSize, setMeasuredSize] = useState<{ width: number; height: number }>({
    width: containerWidth,
    height: containerHeight || 150,
  });

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const { width: w, height: h } = entry.contentRect;
        if (w > 0 && h > 0) {
          setMeasuredSize({ width: Math.round(w), height: Math.round(h) });
        }
      }
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const wheelSize = useMemo(() => {
    const availW = Math.max(72, measuredSize.width - 12);
    const availH = Math.max(72, measuredSize.height - 8);
    return Math.min(200, Math.round(Math.min(availW, availH)));
  }, [measuredSize.width, measuredSize.height]);

  const cx = wheelSize / 2;
  const cy = wheelSize / 2;
  const outerRadius = Math.max(20, wheelSize / 2 - 4);
  const ringThickness = Math.max(11, Math.round(wheelSize * 0.1));
  const innerRadius = outerRadius - ringThickness;
  const squareSize = Math.max(10, Math.floor((innerRadius - 5) * Math.SQRT2));
  const sqX = cx - squareSize / 2;
  const sqY = cy - squareSize / 2;

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

    // 1. Hue Ring
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
    ctx.restore();

    // 2. Hue Indicator
    ctx.save();
    const hueAngle = ((hsv.h + HUE_OFFSET) * Math.PI) / 180;
    ctx.translate(cx, cy);
    ctx.rotate(hueAngle);
    const midRadius = (outerRadius + innerRadius) / 2;
    const handleRadius = ringThickness / 2 + 1;
    ctx.beginPath();
    ctx.arc(midRadius, 0, handleRadius, 0, Math.PI * 2);
    ctx.strokeStyle = 'rgba(0, 0, 0, 0.7)';
    ctx.lineWidth = 2.5;
    ctx.stroke();
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 1.5;
    ctx.stroke();
    ctx.restore();

    // 3. Inner SV Area
    if (wheelMode === 'square') {
      ctx.save();
      const pureRgb = hsvToRgb(hsv.h, 1, 1);
      ctx.fillStyle = `rgb(${pureRgb.r}, ${pureRgb.g}, ${pureRgb.b})`;
      ctx.fillRect(sqX, sqY, squareSize, squareSize);

      const gradWhite = ctx.createLinearGradient(sqX, sqY, sqX + squareSize, sqY);
      gradWhite.addColorStop(0, 'rgba(255, 255, 255, 1)');
      gradWhite.addColorStop(1, 'rgba(255, 255, 255, 0)');
      ctx.fillStyle = gradWhite;
      ctx.fillRect(sqX, sqY, squareSize, squareSize);

      const gradBlack = ctx.createLinearGradient(sqX, sqY, sqX, sqY + squareSize);
      gradBlack.addColorStop(0, 'rgba(0, 0, 0, 0)');
      gradBlack.addColorStop(1, 'rgba(0, 0, 0, 1)');
      ctx.fillStyle = gradBlack;
      ctx.fillRect(sqX, sqY, squareSize, squareSize);

      const curX = sqX + hsv.s * squareSize;
      const curY = sqY + (1 - hsv.v) * squareSize;
      const cursorRadius = 4;

      ctx.beginPath();
      ctx.arc(curX, curY, cursorRadius, 0, Math.PI * 2);
      ctx.strokeStyle = 'rgba(0, 0, 0, 0.75)';
      ctx.lineWidth = 2.5;
      ctx.stroke();
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = 1.5;
      ctx.stroke();
      ctx.restore();
    } else {
      ctx.save();
      const tipAngle = ((hsv.h + HUE_OFFSET) * Math.PI) / 180;
      const rTri = innerRadius - 5;
      const pTip = { x: cx + rTri * Math.cos(tipAngle), y: cy + rTri * Math.sin(tipAngle) };
      const pWhite = {
        x: cx + rTri * Math.cos(tipAngle + (2 * Math.PI) / 3),
        y: cy + rTri * Math.sin(tipAngle + (2 * Math.PI) / 3),
      };
      const pBlack = {
        x: cx + rTri * Math.cos(tipAngle - (2 * Math.PI) / 3),
        y: cy + rTri * Math.sin(tipAngle - (2 * Math.PI) / 3),
      };

      ctx.beginPath();
      ctx.moveTo(pTip.x, pTip.y);
      ctx.lineTo(pWhite.x, pWhite.y);
      ctx.lineTo(pBlack.x, pBlack.y);
      ctx.closePath();
      ctx.save();
      ctx.clip();

      const pureRgb = hsvToRgb(hsv.h, 1, 1);
      ctx.fillStyle = `rgb(${pureRgb.r}, ${pureRgb.g}, ${pureRgb.b})`;
      ctx.fill();

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
      ctx.restore();

      const wA = hsv.s * hsv.v;
      const wB = (1 - hsv.s) * hsv.v;
      const wC = 1 - hsv.v;
      const curX = wA * pTip.x + wB * pWhite.x + wC * pBlack.x;
      const curY = wA * pTip.y + wB * pWhite.y + wC * pBlack.y;

      ctx.beginPath();
      ctx.arc(curX, curY, 4, 0, Math.PI * 2);
      ctx.strokeStyle = 'rgba(0, 0, 0, 0.75)';
      ctx.lineWidth = 2.5;
      ctx.stroke();
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = 1.5;
      ctx.stroke();
      ctx.restore();
    }
  }, [cx, cy, outerRadius, innerRadius, ringThickness, sqX, sqY, squareSize, wheelSize, hsv, wheelMode]);

  const sampleTriangleSV = (px: number, py: number) => {
    const rTri = innerRadius - 5;
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
    let wA = ((pWhite.y - pBlack.y) * (px - pBlack.x) + (pBlack.x - pWhite.x) * (py - pBlack.y)) / det;
    let wB = ((pBlack.y - pTip.y) * (px - pBlack.x) + (pTip.x - pBlack.x) * (py - pBlack.y)) / det;
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
    return { s, v };
  };

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

    if (dist >= innerRadius - 4 && dist <= outerRadius + 6) {
      setIsDragging('hue');
      const deg = (Math.atan2(dy, dx) * 180) / Math.PI;
      const newHue = Math.round((deg - HUE_OFFSET + 360) % 360);
      handleColorChange({ ...hsv, h: newHue }, false);
      return;
    }

    if (dist < innerRadius - 4) {
      setIsDragging('sv');
      if (wheelMode === 'square') {
        const s = Math.max(0, Math.min(1, (px - sqX) / squareSize));
        const v = Math.max(0, Math.min(1, 1 - (py - sqY) / squareSize));
        handleColorChange({ ...hsv, s, v }, false);
      } else {
        const { s, v } = sampleTriangleSV(px, py);
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
      const deg = (Math.atan2(py - cy, px - cx) * 180) / Math.PI;
      const newHue = Math.round((deg - HUE_OFFSET + 360) % 360);
      handleColorChange({ ...hsv, h: newHue }, false);
    } else if (isDragging === 'sv') {
      if (wheelMode === 'square') {
        const s = Math.max(0, Math.min(1, (px - sqX) / squareSize));
        const v = Math.max(0, Math.min(1, 1 - (py - sqY) / squareSize));
        handleColorChange({ ...hsv, s, v }, false);
      } else {
        const { s, v } = sampleTriangleSV(px, py);
        handleColorChange({ ...hsv, s, v }, false);
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
    handleColorChange(hsv, true);
  };

  return (
    <div
      ref={containerRef}
      className="relative flex-1 min-h-0 w-full h-full flex items-center justify-center select-none"
    >
      <canvas
        ref={canvasRef}
        style={{ width: wheelSize, height: wheelSize }}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerUp}
        className="block cursor-crosshair touch-none"
      />

      <button
        type="button"
        onClick={() => setWheelMode((m) => (m === 'square' ? 'triangle' : 'square'))}
        title={`Switch to ${wheelMode === 'square' ? 'Triangle' : 'Square'} Mode`}
        className="absolute bottom-1 right-1.5 w-5 h-5 rounded flex items-center justify-center text-[#8a8a8a] hover:text-[#e5e5e5] hover:bg-[#2c2c2c] transition-colors cursor-pointer"
      >
        {wheelMode === 'square' ? (
          <Play className="w-2.5 h-2.5 rotate-90 fill-current" />
        ) : (
          <Square className="w-2.5 h-2.5" />
        )}
      </button>
    </div>
  );
};
