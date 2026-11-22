import React from 'react';
import {
  ToolType,
  BrushSettings,
  Point,
  CanvasDimensions,
  CanvasSelection,
  HistoryActionType,
  CanvasColorMode,
  DirtyRect,
  LayerItem,
  TileDelta,
  VectorStroke,
} from '../../types/editor';
import { SparseTileGrid } from '../../utils/tileEngine';
import { CanvasNavigationHandle } from '../useCanvasNavigation';
import { PerspectiveRuler, StraightRuler, ConstraintAxis } from '../../types/perspective';

export interface DraftCanvasElement extends HTMLCanvasElement {
  __draftHasContent?: boolean;
  __draftCompositeOp?: GlobalCompositeOperation;
  __draftSpace?: 'document' | 'viewport';
  __draftDocRect?: { x: number; y: number; width: number; height: number };
  __draftScale?: number;
  __draftMonochrome?: boolean;
  __draftVersion?: number;
  __isBlank?: boolean;
  __isSolidWhite?: boolean;
}

export interface ExtendedPointerEvent extends React.PointerEvent<HTMLElement> {
  coalescedEvents?: PointerEvent[];
  predictedEvents?: PointerEvent[];
}

export interface LastStrokeEndState {
  x: number;
  y: number;
  pressure: number;
  width: number;
  layerId: string;
}

export type PushHistoryStepFn = (
  actionType: HistoryActionType,
  label: string,
  beforeData: ImageData | null,
  afterData: ImageData | null,
  targetLayerId: string,
  dirtyRect?: DirtyRect,
  explicitTileDeltas?: TileDelta[],
  vectorDelta?: { before: VectorStroke[]; after: VectorStroke[] },
  peerId?: string | number,
  strokeId?: string,
  isMaskEdit?: boolean
) => void;

export interface UseCanvasDrawingProps {
  tool?: ToolType;
  brushSettings?: BrushSettings;
  dimensions: CanvasDimensions;
  selection?: CanvasSelection | null;
  colorMode?: CanvasColorMode;
  disabled?: boolean;
  viewportRef: React.RefObject<HTMLDivElement | null>;
  pan: { x: number; y: number };
  zoom: number;
  rotation: number;
  flipX?: boolean;
  flipY?: boolean;
  navigation?: CanvasNavigationHandle;
  activeLayerId: string;
  activeLayerLocked?: boolean;
  activeLayerVisible?: boolean;
  layers?: LayerItem[];
  onUpdateLayerThumbnail: (layerId: string) => void;
  isMaskMode?: boolean;
  onUpdateMaskThumbnail?: (layerId: string) => void;
  draftCanvasRef?: React.RefObject<HTMLCanvasElement | null>;
  strokeCanvasRef?: React.RefObject<HTMLCanvasElement | null>;
  predictedCanvasRef?: React.RefObject<HTMLCanvasElement | null>;
  onCollabStrokeStart?: (
    strokeId: string,
    layerId: string,
    brushSettings: BrushSettings,
    tool: ToolType,
    startPoint: Point
  ) => void;
  onCollabStrokeChunk?: (strokeId: string, points: Point[]) => void;
  onCollabStrokeFinish?: (
    strokeId: string,
    layerId: string,
    endPoint: Point,
    dirtyRect?: DirtyRect,
    vectorStroke?: VectorStroke
  ) => void;
  onCollabCursorMove?: (x: number, y: number, isDrawing: boolean, tool: ToolType) => void;
  perspectiveRuler?: PerspectiveRuler | null;
  straightRuler?: StraightRuler | null;
  onActiveConstraintAxisChange?: (axis: ConstraintAxis | null) => void;
  activeSessionId?: string | null;
  tileGrid?: SparseTileGrid;
}

export function isBackgroundLayerId(id: string): boolean {
  return id === 'layer-bg' || id.startsWith('layer-bg');
}

export function applySelectionCanvasClip(
  ctx: CanvasRenderingContext2D,
  sel: CanvasSelection | null | undefined
): void {
  if (!sel) return;
  if (sel.type === 'rect') {
    ctx.beginPath();
    ctx.rect(sel.bounds.x, sel.bounds.y, sel.bounds.width, sel.bounds.height);
    ctx.clip();
  } else if (sel.type === 'lasso' && sel.polygon && sel.polygon.length >= 3) {
    ctx.beginPath();
    ctx.moveTo(sel.polygon[0].x, sel.polygon[0].y);
    for (let i = 1; i < sel.polygon.length; i++) {
      ctx.lineTo(sel.polygon[i].x, sel.polygon[i].y);
    }
    ctx.closePath();
    ctx.clip();
  } else if (sel.svgPath && typeof Path2D !== 'undefined') {
    try {
      ctx.clip(new Path2D(sel.svgPath), 'evenodd');
    } catch {
      ctx.beginPath();
      ctx.rect(sel.bounds.x, sel.bounds.y, sel.bounds.width, sel.bounds.height);
      ctx.clip();
    }
  }
}

export function applySelectionMaskToImageData(
  beforeData: ImageData,
  afterData: ImageData,
  rx: number,
  ry: number,
  sel: CanvasSelection | null | undefined
): void {
  if (!sel || !sel.mask || !sel.maskWidth || !sel.maskHeight) return;
  const mask = sel.mask;
  const mw = sel.maskWidth;
  const mh = sel.maskHeight;
  const w = afterData.width;
  const h = afterData.height;
  const src = beforeData.data;
  const dst = afterData.data;

  for (let ly = 0; ly < h; ly++) {
    const docY = ry + ly;
    const inY = docY >= 0 && docY < mh;
    const maskRow = docY * mw;
    const imgRow = ly * w;
    for (let lx = 0; lx < w; lx++) {
      const docX = rx + lx;
      const mAlpha = inY && docX >= 0 && docX < mw ? mask[maskRow + docX] : 0;
      if (mAlpha === 255) continue;
      const idx = (imgRow + lx) * 4;
      if (mAlpha === 0) {
        dst[idx] = src[idx];
        dst[idx + 1] = src[idx + 1];
        dst[idx + 2] = src[idx + 2];
        dst[idx + 3] = src[idx + 3];
      } else {
        const wAfter = mAlpha / 255;
        const wBefore = 1 - wAfter;
        const aB = (src[idx + 3] / 255) * wBefore;
        const aA = (dst[idx + 3] / 255) * wAfter;
        const outA = aB + aA;
        if (outA <= 0.0001) {
          dst[idx] = 0;
          dst[idx + 1] = 0;
          dst[idx + 2] = 0;
          dst[idx + 3] = 0;
        } else {
          dst[idx] = Math.round((src[idx] * aB + dst[idx] * aA) / outA);
          dst[idx + 1] = Math.round((src[idx + 1] * aB + dst[idx + 1] * aA) / outA);
          dst[idx + 2] = Math.round((src[idx + 2] * aB + dst[idx + 2] * aA) / outA);
          dst[idx + 3] = Math.round(outA * 255);
        }
      }
    }
  }
}
