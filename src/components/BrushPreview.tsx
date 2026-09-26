import React, { useRef, useEffect, useState } from 'react';
import { BrushSettings, BrushPresetId } from '../types/editor';
import { renderBrushStrokePreview, BrushPreviewOptions } from '../utils/brushPreview';
import { getPreloadedTipImage, preloadTipImage } from '../utils/brushStorage';

interface BrushPreviewProps {
  preset?: BrushPresetId;
  settings?: Partial<BrushSettings>;
  tool?: 'brush' | 'eraser';
  strokeColor?: string;
  backgroundColor?: string;
  className?: string;
  width?: number;
  height?: number;
  isLiveCard?: boolean;
  customTipImage?: HTMLImageElement;
  customTipAngle?: number;
}

export const BrushPreview: React.FC<BrushPreviewProps> = React.memo(({
  preset = 'pencil-2b',
  settings,
  tool = 'brush',
  strokeColor = '#ffffff',
  backgroundColor = 'transparent',
  className = '',
  width: fixedWidth,
  height: fixedHeight = 34,
  isLiveCard = false,
  customTipImage,
  customTipAngle,
}) => {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [measuredWidth, setMeasuredWidth] = useState<number>(fixedWidth || 140);
  const rafIdRef = useRef<number | null>(null);

  const tipUrl = customTipImage?.src || settings?.customTipDataUrl || (settings as any)?.tipDataUrl;
  const [internalTipImage, setInternalTipImage] = useState<HTMLImageElement | undefined>(() => {
    if (customTipImage) return customTipImage;
    if (tipUrl) return getPreloadedTipImage(tipUrl) || undefined;
    return undefined;
  });

  useEffect(() => {
    if (customTipImage) {
      setInternalTipImage(customTipImage);
      return;
    }
    if (tipUrl) {
      const cached = getPreloadedTipImage(tipUrl);
      if (cached) {
        setInternalTipImage(cached);
      } else {
        preloadTipImage(tipUrl)
          .then((img) => setInternalTipImage(img))
          .catch(() => {});
      }
    } else {
      setInternalTipImage(undefined);
    }
  }, [customTipImage, tipUrl]);

  // ResizeObserver for auto-responsive width when fixedWidth is not supplied
  useEffect(() => {
    if (fixedWidth) {
      setMeasuredWidth(fixedWidth);
      return;
    }

    const container = containerRef.current;
    if (!container) return;

    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const w = Math.round(entry.contentRect.width);
        if (w > 20) {
          setMeasuredWidth(w);
        }
      }
    });

    observer.observe(container);
    return () => observer.disconnect();
  }, [fixedWidth]);

  // Render stroke preview
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || measuredWidth <= 0 || fixedHeight <= 0) return;

    if (rafIdRef.current !== null) {
      cancelAnimationFrame(rafIdRef.current);
    }

    rafIdRef.current = requestAnimationFrame(() => {
      rafIdRef.current = null;

      const opts: BrushPreviewOptions = {
        preset,
        size: settings?.size,
        flow: settings?.flow,
        opacity: settings?.opacity,
        grain: settings?.grain,
        hardness: settings?.hardness,
        minSizeFactor: settings?.minSizeFactor,
        thickness: settings?.thickness,
        antiAlias: settings?.antiAlias,
        pressureCurve: settings?.pressureCurve,
        spray: settings?.spray,
        usePressure: settings?.usePressure,
        color: strokeColor,
        backgroundColor,
        tool,
        customTipImage: customTipImage || internalTipImage || settings?.customTipImage,
        customTipAngle: customTipAngle !== undefined ? customTipAngle : settings?.customTipAngle,
        colorMixing: settings?.colorMixing,
        amountOfPaint: settings?.amountOfPaint,
        densityOfPaint: settings?.densityOfPaint,
        colorStretch: settings?.colorStretch,
        wetEdge: settings?.wetEdge,
      };

      renderBrushStrokePreview(canvas, measuredWidth, fixedHeight, opts, isLiveCard);
    });

    return () => {
      if (rafIdRef.current !== null) {
        cancelAnimationFrame(rafIdRef.current);
        rafIdRef.current = null;
      }
    };
  }, [
    preset,
    settings?.size,
    settings?.flow,
    settings?.opacity,
    settings?.grain,
    settings?.hardness,
    settings?.minSizeFactor,
    settings?.usePressure,
    settings?.customTipImage,
    settings?.customTipAngle,
    settings?.colorMixing,
    settings?.amountOfPaint,
    settings?.densityOfPaint,
    settings?.colorStretch,
    settings?.wetEdge,
    customTipImage,
    internalTipImage,
    customTipAngle,
    tool,
    strokeColor,
    backgroundColor,
    measuredWidth,
    fixedHeight,
    isLiveCard,
  ]);

  return (
    <div
      ref={containerRef}
      style={{ height: fixedHeight, width: fixedWidth ? fixedWidth : '100%' }}
      className={`relative overflow-hidden pointer-events-none select-none flex items-center justify-center ${className}`}
    >
      <canvas
        ref={canvasRef}
        style={{
          width: `${measuredWidth}px`,
          height: `${fixedHeight}px`,
        }}
        className="block will-change-transform"
      />
    </div>
  );
});

BrushPreview.displayName = 'BrushPreview';
