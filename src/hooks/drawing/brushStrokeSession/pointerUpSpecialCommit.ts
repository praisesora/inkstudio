import {
  BrushSettings,
  CanvasSelection,
  DirtyRect,
  LayerItem,
  Point,
  ToolType,
} from '../../../types/editor';
import { get2DContext, getReusableBakeCanvas } from '../../../utils/canvasUtils';
import { renderCompleteStroke } from '../../../engine/BrushEngine';
import { multiplayerService } from '../../../services/multiplayerService';
import {
  PushHistoryStepFn,
  applySelectionCanvasClip,
  applySelectionMaskToImageData,
} from '../types';

export type StrokeHistoryToolType = 'eraser' | 'pencil' | 'brush';

export function resolveStrokeHistoryLabel(
  bs: BrushSettings,
  currentTool: ToolType,
  isMonochrome: boolean
): string {
  if (bs.isTransparentInk) return 'Transparent Ink';
  if (currentTool === 'eraser') return 'Eraser';
  if (bs.brushName) return bs.brushName;
  if (bs.preset === 'pencil-f') return 'Pencil (F)';
  if (bs.preset === 'pencil-2b') return 'Pencil (2B)';
  if (bs.preset === 'pencil-4b') return 'Pencil (4B)';
  if (bs.preset === 'pencil-hb') return 'Pencil (HB)';
  return isMonochrome ? 'Monochrome Pen' : 'Round Brush';
}

export interface CommitMaskModeStrokeParams {
  canvas: HTMLCanvasElement;
  dirtyRect: DirtyRect;
  bs: BrushSettings;
  strokeColor: string;
  isEraser: boolean;
  currentTool: ToolType;
  allPoints: Point[];
  activeSelection: CanvasSelection | null;
  activeLayer: LayerItem | undefined;
  currentLayerId: string;
  toolForHistory: StrokeHistoryToolType;
  strokeIdForHistory: string | undefined;
  enqueueHistoryTask: (task: () => void) => void;
  pushHistoryStep: PushHistoryStepFn;
}

export function commitMaskModeStroke({
  canvas,
  dirtyRect,
  bs,
  strokeColor,
  isEraser,
  currentTool,
  allPoints,
  activeSelection,
  activeLayer,
  currentLayerId,
  toolForHistory,
  strokeIdForHistory,
  enqueueHistoryTask,
  pushHistoryStep,
}: CommitMaskModeStrokeParams): void {
  const ctx = get2DContext(canvas);
  if (!ctx) return;

  const { x: sx, y: sy, width: dw, height: dh } = dirtyRect;
  const beforeMaskData = ctx.getImageData(sx, sy, dw, dh);
  const maskBs: BrushSettings = {
    ...bs,
    color: strokeColor,
    isTransparentInk: false,
    colorMixing: false,
  };
  const maskTool: ToolType = isEraser ? 'brush' : currentTool;

  ctx.save();
  ctx.beginPath();
  ctx.rect(sx, sy, dw, dh);
  ctx.clip();
  applySelectionCanvasClip(ctx, activeSelection);

  if ((bs.opacity ?? 1.0) >= 0.999) {
    renderCompleteStroke(ctx, allPoints, maskBs, maskTool, 'grayscale', false, canvas, false);
  } else {
    ctx.globalAlpha = Math.max(0.01, Math.min(1.0, bs.opacity ?? 1.0));
    ctx.globalCompositeOperation = 'source-over';
    const bakeCanvas = getReusableBakeCanvas(dw, dh);
    const bCtx = bakeCanvas.getContext('2d', { alpha: true });
    if (bCtx) {
      bCtx.resetTransform();
      bCtx.clearRect(0, 0, dw, dh);
      bCtx.save();
      bCtx.translate(-sx, -sy);
      renderCompleteStroke(
        bCtx,
        allPoints,
        { ...maskBs, opacity: 1.0 },
        maskTool,
        'grayscale',
        false,
        canvas,
        false
      );
      bCtx.restore();
      ctx.drawImage(bakeCanvas, 0, 0, dw, dh, sx, sy, dw, dh);
    }
  }
  ctx.restore();

  const afterMaskData = ctx.getImageData(sx, sy, dw, dh);
  if (activeSelection?.mask) {
    applySelectionMaskToImageData(beforeMaskData, afterMaskData, sx, sy, activeSelection);
    ctx.putImageData(afterMaskData, sx, sy);
  }
  if (activeLayer) {
    activeLayer.maskVersion = (activeLayer.maskVersion || 0) + 1;
  }
  if (multiplayerService.isConnected()) {
    multiplayerService.sendLayerMaskData(currentLayerId, canvas, dirtyRect);
  }
  enqueueHistoryTask(() => {
    pushHistoryStep(
      toolForHistory,
      'Layer Mask Stroke',
      beforeMaskData,
      afterMaskData,
      currentLayerId,
      dirtyRect,
      undefined,
      undefined,
      undefined,
      strokeIdForHistory,
      true
    );
  });
}
