import React, { useRef, useEffect, useState } from 'react';
import { BrushSettings, BrushPresetId, CspSubTip } from '../types/editor';
import { renderBrushStrokePreview, BrushPreviewOptions } from '../utils/brushPreview';
import { getPreloadedTipImage, preloadTipImage } from '../utils/brushStorage';
import { DEFAULT_BRUSH_PRESET_ID } from '../utils/brushPresetManager';

interface BrushPreviewProps {
  preset?: BrushPresetId;
  settings?: Partial<BrushSettings>;
  tool?: 'brush' | 'eraser';
  strokeColor?: string;
  secondaryColor?: string;
  backgroundColor?: string;
  className?: string;
  width?: number;
  height?: number;
  isLiveCard?: boolean;
  customTipImage?: HTMLImageElement;
  customTipAngle?: number;
}

function resolveCachedSubTips(
  subTips?: CspSubTip[],
  existing?: HTMLImageElement[]
): HTMLImageElement[] | undefined {
  if (existing && existing.length > 0) return existing;
  if (!subTips || subTips.length === 0) return undefined;
  const out: HTMLImageElement[] = [];
  for (const st of subTips) {
    const img = getPreloadedTipImage(st.dataUrl);
    if (img) out.push(img);
  }
  return out.length > 0 ? out : undefined;
}

export const BrushPreview: React.FC<BrushPreviewProps> = React.memo(({
  preset = DEFAULT_BRUSH_PRESET_ID,
  settings,
  tool = 'brush',
  strokeColor = '#ffffff',
  secondaryColor,
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
  const [assetLoadRevision, setAssetLoadRevision] = useState<number>(0);

  const tipUrl =
    customTipImage?.src ||
    settings?.customTipDataUrl ||
    (settings as { tipDataUrl?: string } | undefined)?.tipDataUrl;
  const dualTipUrl =
    settings?.dualTipImage?.src ||
    settings?.dualTipDataUrl ||
    settings?.dualBrushConfig?.tipDataUrl ||
    (settings as { secondaryTipDataUrl?: string } | undefined)?.secondaryTipDataUrl;
  const paperUrl = settings?.paperTextureImage?.src || settings?.paperTexture;

  const [internalTipImage, setInternalTipImage] = useState<HTMLImageElement | undefined>(() => {
    if (customTipImage) return customTipImage;
    if (tipUrl) return getPreloadedTipImage(tipUrl) || undefined;
    return undefined;
  });
  const [internalDualTipImage, setInternalDualTipImage] = useState<HTMLImageElement | undefined>(() => {
    if (settings?.dualTipImage) return settings.dualTipImage;
    if (settings?.dualBrushConfig?.tipImage) return settings.dualBrushConfig.tipImage;
    if (dualTipUrl) return getPreloadedTipImage(dualTipUrl) || undefined;
    return undefined;
  });
  const [internalPaperImage, setInternalPaperImage] = useState<HTMLImageElement | undefined>(() => {
    if (settings?.paperTextureImage) return settings.paperTextureImage;
    if (paperUrl) return getPreloadedTipImage(paperUrl) || undefined;
    return undefined;
  });

  // Preload primary tip, dual tip, paper texture, and sub-tip arrays
  useEffect(() => {
    let cancelled = false;
    const bump = () => {
      if (!cancelled) setAssetLoadRevision((r) => r + 1);
    };

    if (customTipImage) {
      setInternalTipImage(customTipImage);
    } else if (tipUrl) {
      const cached = getPreloadedTipImage(tipUrl);
      if (cached) {
        setInternalTipImage(cached);
      } else {
        preloadTipImage(tipUrl)
          .then((img) => {
            if (!cancelled) setInternalTipImage(img);
          })
          .catch(() => {});
      }
    } else {
      setInternalTipImage(undefined);
    }

    const explicitDual = settings?.dualTipImage || settings?.dualBrushConfig?.tipImage;
    if (explicitDual) {
      setInternalDualTipImage(explicitDual);
    } else if (dualTipUrl) {
      const cached = getPreloadedTipImage(dualTipUrl);
      if (cached) {
        setInternalDualTipImage(cached);
      } else {
        preloadTipImage(dualTipUrl)
          .then((img) => {
            if (!cancelled) setInternalDualTipImage(img);
          })
          .catch(() => {});
      }
    } else {
      setInternalDualTipImage(undefined);
    }

    if (settings?.paperTextureImage) {
      setInternalPaperImage(settings.paperTextureImage);
    } else if (paperUrl) {
      const cached = getPreloadedTipImage(paperUrl);
      if (cached) {
        setInternalPaperImage(cached);
      } else {
        preloadTipImage(paperUrl)
          .then((img) => {
            if (!cancelled) setInternalPaperImage(img);
          })
          .catch(() => {});
      }
    } else {
      setInternalPaperImage(undefined);
    }

    const subTipsToLoad = [
      ...(settings?.subTips || []),
      ...(settings?.dualSubTips || settings?.dualBrushConfig?.subTips || []),
    ];
    for (const st of subTipsToLoad) {
      if (st.dataUrl && !getPreloadedTipImage(st.dataUrl)) {
        preloadTipImage(st.dataUrl).then(bump).catch(() => {});
      }
    }

    return () => {
      cancelled = true;
    };
  }, [
    customTipImage,
    tipUrl,
    dualTipUrl,
    paperUrl,
    settings?.dualTipImage,
    settings?.dualBrushConfig?.tipImage,
    settings?.paperTextureImage,
    settings?.subTips,
    settings?.dualSubTips,
    settings?.dualBrushConfig?.subTips,
  ]);

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

  // Render stroke preview through the full unified renderCompleteStroke pipeline
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || measuredWidth <= 0 || fixedHeight <= 0) return;

    if (rafIdRef.current !== null) {
      cancelAnimationFrame(rafIdRef.current);
    }

    rafIdRef.current = requestAnimationFrame(() => {
      rafIdRef.current = null;

      const resolvedDualTipImg =
        internalDualTipImage || settings?.dualTipImage || settings?.dualBrushConfig?.tipImage;
      const resolvedSubTipImgs = resolveCachedSubTips(settings?.subTips, settings?.subTipImages);
      const resolvedDualSubTipImgs = resolveCachedSubTips(
        settings?.dualSubTips || settings?.dualBrushConfig?.subTips,
        settings?.dualSubTipImages || settings?.dualBrushConfig?.subTipImages
      );

      const opts: BrushPreviewOptions = {
        preset,
        size: settings?.size,
        flow: settings?.flow,
        brushDensity: settings?.brushDensity,
        opacity: settings?.opacity,
        grain: settings?.grain ?? settings?.textureDensity,
        textureDensity: settings?.textureDensity,
        paperTexture: settings?.paperTexture,
        paperTextureImage: internalPaperImage || settings?.paperTextureImage,
        paperTextureMode: settings?.paperTextureMode,
        paperTextureScale: settings?.paperTextureScale,
        paperTextureRotate: settings?.paperTextureRotate,
        paperTextureOffsetX: settings?.paperTextureOffsetX,
        paperTextureOffsetY: settings?.paperTextureOffsetY,
        paperTextureContrast: settings?.paperTextureContrast,
        paperTextureBrightness: settings?.paperTextureBrightness,
        paperTextureApplyEachPlot: settings?.paperTextureApplyEachPlot,
        paperTextureEmphasizeDensity: settings?.paperTextureEmphasizeDensity,
        paperTextureInverted: settings?.paperTextureInverted,
        surfaceTextureId: settings?.surfaceTextureId,
        grainMappingMode: settings?.grainMappingMode,
        hardness: settings?.hardness,
        spacing: settings?.spacing,
        minSizeFactor: settings?.minSizeFactor,
        thickness: settings?.thickness,
        thicknessVertical: settings?.thicknessVertical,
        thicknessSensor: settings?.thicknessSensor,
        flipH: settings?.flipH,
        flipV: settings?.flipV,
        blendTipsMode: settings?.blendTipsMode,
        brushCombineMode: settings?.brushCombineMode,
        adjustDensityByGap: settings?.adjustDensityByGap,
        antiAlias: settings?.antiAlias,
        pressureCurve: settings?.pressureCurve,
        velocityCurve: settings?.velocityCurve,
        sizeSensor: settings?.sizeSensor,
        opacitySensor: settings?.opacitySensor,
        densitySensor: settings?.densitySensor,
        intervalSensor: settings?.intervalSensor,
        textureDensitySensor: settings?.textureDensitySensor,
        angleSensor: settings?.angleSensor,
        scatterSensor: settings?.scatterSensor,
        spray: settings?.spray,
        taper: settings?.taper,
        dynamics: settings?.dynamics,
        usePressure: settings?.usePressure,
        useTilt: settings?.useTilt,
        tiltScale: settings?.tiltScale,
        useVelocity: settings?.useVelocity,
        color: strokeColor,
        secondaryColor: secondaryColor ?? settings?.secondaryColor,
        backgroundColor,
        tool,
        customTipDataUrl: settings?.customTipDataUrl,
        customTipImage: customTipImage || internalTipImage || settings?.customTipImage,
        customTipAngle: customTipAngle !== undefined ? customTipAngle : settings?.customTipAngle,
        customTipAngleDynamics: settings?.customTipAngleDynamics,
        customTipRotationRandomScale: settings?.customTipRotationRandomScale,
        isColorTip: settings?.isColorTip,
        isDualToneTip: settings?.isDualToneTip,
        isRibbon: settings?.isRibbon,
        subTips: settings?.subTips,
        subTipOrder: settings?.subTipOrder,
        subTipImages: resolvedSubTipImgs,
        colorMixing: settings?.colorMixing,
        perceptualMixing: settings?.perceptualMixing,
        amountOfPaint: settings?.amountOfPaint,
        densityOfPaint: settings?.densityOfPaint,
        colorStretch: settings?.colorStretch,
        amountOfPaintSensor: settings?.amountOfPaintSensor,
        densityOfPaintSensor: settings?.densityOfPaintSensor,
        colorStretchSensor: settings?.colorStretchSensor,
        mixingMode: settings?.mixingMode,
        wetEdge: settings?.wetEdge,
        wetEdgeRadius: settings?.wetEdgeRadius,
        wetEdgeAlphaPower: settings?.wetEdgeAlphaPower,
        wetEdgeValuePower: settings?.wetEdgeValuePower,
        dualBrush: settings?.dualBrush,
        dualBrushConfig: settings?.dualBrushConfig
          ? {
              ...settings.dualBrushConfig,
              tipImage: resolvedDualTipImg,
              subTipImages: resolvedDualSubTipImgs,
            }
          : undefined,
        dualBrushCompositeMode: settings?.dualBrushCompositeMode,
        dualTipDataUrl: dualTipUrl,
        dualTipImage: resolvedDualTipImg,
        dualSize: settings?.dualSize,
        dualLinkSize: settings?.dualLinkSize,
        dualSpacing: settings?.dualSpacing,
        dualScatter: settings?.dualScatter,
        dualThickness: settings?.dualThickness,
        dualThicknessVertical: settings?.dualThicknessVertical,
        dualAngle: settings?.dualAngle,
        dualAngleDynamics: settings?.dualAngleDynamics,
        dualAngleSensor: settings?.dualAngleSensor,
        dualHardness: settings?.dualHardness,
        dualDensity: settings?.dualDensity,
        dualSubTips: settings?.dualSubTips,
        dualSubTipImages: resolvedDualSubTipImgs,
        dualSubTipOrder: settings?.dualSubTipOrder,
        dualFlipH: settings?.dualFlipH,
        dualFlipV: settings?.dualFlipV,
        dualSpray: settings?.dualSpray,
        dualIsRibbon: settings?.dualIsRibbon,
        dualScale: settings?.dualScale,
        dualSurfaceTextureId: settings?.dualSurfaceTextureId,
        dualGrainDepth: settings?.dualGrainDepth,
        renderMode: settings?.renderMode,
        bristle: settings?.bristle,
        naturalPaint: settings?.naturalPaint,
        impasto: settings?.impasto,
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
    settings,
    customTipImage,
    internalTipImage,
    internalDualTipImage,
    internalPaperImage,
    dualTipUrl,
    customTipAngle,
    assetLoadRevision,
    tool,
    strokeColor,
    secondaryColor,
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
