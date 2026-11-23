import React from 'react';
import {
  CanvasDimensions,
  BrushSettings,
  LayerItem,
  CanvasSelection,
  TransformSession,
  TextSettings,
  ToolType,
  LiquifySettings,
  SpeechBalloon,
  SoftProofSettings,
  CanvasColorMode,
  ShapeDragPreview,
  GradientDragPreview,
  GradientMeshState,
  GradientSettings,
  RetouchSettings,
  PenPathSession,
  PenToolSettings,
  AnimationTimeline as AnimationTimelineType,
} from '../../types/editor';
import type { CloneSourceIndicator } from '../../hooks/drawing/useRetouchTool';
import { ROTATE_CURSOR_CSS, CanvasNavigationHandle } from '../../hooks/useCanvasNavigation';
import { PerspectiveRuler, StraightRuler, ConstraintAxis } from '../../types/perspective';
import { SparseTileGrid } from '../../utils/tileEngine';
import { ModifierAction } from '../../types/settings';

export const PIPETTE_CURSOR_CSS = `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='24' height='24' viewBox='0 0 24 24'%3E%3Cg stroke='%23000000' stroke-width='3.5' stroke-linecap='round' stroke-linejoin='round' fill='none'%3E%3Cpath d='m14 7 3 3'/%3E%3Cpath d='M16.6 5.6a2.12 2.12 0 0 1 3 3L7 20.6 2 22l1.4-5L16.6 5.6z'/%3E%3C/g%3E%3Cg stroke='%23ffffff' stroke-width='1.5' stroke-linecap='round' stroke-linejoin='round' fill='none'%3E%3Cpath d='m14 7 3 3'/%3E%3Cpath d='M16.6 5.6a2.12 2.12 0 0 1 3 3L7 20.6 2 22l1.4-5L16.6 5.6z'/%3E%3C/g%3E%3C/svg%3E") 2 22, crosshair`;

export interface CanvasAreaProps {
  viewportRef: React.RefObject<HTMLDivElement | null>;
  dimensions: CanvasDimensions;
  brushSettings: BrushSettings;
  onUpdateBrushSettings: (newSettings: Partial<BrushSettings>) => void;
  zoom: number;
  pan: { x: number; y: number };
  rotation: number;
  flipX?: boolean;
  flipY?: boolean;
  navigation?: CanvasNavigationHandle;
  isSpaceDown: boolean;
  isShiftDown: boolean;
  heldModifierAction?: ModifierAction;
  isRotateModifier: boolean;
  isPanning: boolean;
  isRotating: boolean;
  isZoomDragging?: boolean;
  onStartPan: (e: React.PointerEvent) => void;
  onStartRotate: (e: React.PointerEvent) => void;
  onStartZoomDrag?: (e: React.PointerEvent) => void;
  onSampleColor?: (pt: { x: number; y: number }) => void;
  onUndo?: () => void;
  onRedo?: () => void;
  onFlipHorizontal?: () => void;
  isHovering: boolean;
  cursorPos: { x: number; y: number } | null;
  onPointerDown: (e: React.PointerEvent<HTMLElement>, coalesced?: PointerEvent[]) => void;
  onPointerMove: (e: React.PointerEvent<HTMLElement>, coalesced?: PointerEvent[], predicted?: PointerEvent[]) => void;
  onPointerUp: (e: React.PointerEvent<HTMLElement>) => void;
  predictedCanvasRef?: React.RefObject<HTMLCanvasElement | null>;
  onPointerEnter: () => void;
  onPointerLeave: () => void;
  layers: LayerItem[];
  getEffectiveOpacity: (layer: LayerItem) => number;
  isLayerEffectivelyVisible: (layer: LayerItem) => boolean;
  interactionRef: React.RefObject<HTMLDivElement | null>;
  showCheckerboard?: boolean;
  hasOpenDocument?: boolean;
  draftCanvasRef?: React.RefObject<HTMLCanvasElement | null>;
  strokeCanvasRef?: React.RefObject<HTMLCanvasElement | null>;
  peers?: import('../../types/multiplayer').CollabPeer[];
  activePings?: Array<{ id: string; x: number; y: number; color: string; name: string }>;
  remoteDraftCanvasesRef?: React.MutableRefObject<Map<string | number, HTMLCanvasElement>>;
  tool?: ToolType;
  selection?: CanvasSelection | null;
  onDeselect?: () => void;
  onTransformSelection?: () => void;
  onFillScreentone?: () => void;
  onFillColor?: () => void;
  onClearSelection?: () => void;
  onDeleteOutsideSelection?: () => void;
  onCutSelection?: () => void;
  onCopySelection?: () => void;
  onPasteSelection?: () => void;
  onMoveSelectionToNewLayer?: () => void;
  onInvertSelection?: () => void;
  onExpandSelection?: (pixels: number) => void;
  onContractSelection?: (pixels: number) => void;
  onFeatherSelection?: (radius: number) => void;
  transformSession?: TransformSession | null;
  onUpdateTransformSession?: (updater: (prev: TransformSession) => TransformSession) => void;
  onApplyTransform?: () => void;
  onCancelTransform?: () => void;
  textSession?: { x: number; y: number; settings: TextSettings } | null;
  onUpdateTextSettings?: (updater: (prev: TextSettings) => TextSettings) => void;
  onMoveTextSession?: (x: number, y: number) => void;
  onConfirmText?: () => void;
  onCancelText?: () => void;
  perspectiveRuler?: PerspectiveRuler | null;
  onUpdatePerspectiveRuler?: (ruler: PerspectiveRuler | null) => void;
  straightRuler?: StraightRuler | null;
  onUpdateStraightRuler?: (ruler: StraightRuler | null) => void;
  activeLockedAxis?: ConstraintAxis | null;
  isDrawing?: boolean;
  is3DLayerOpen?: boolean;
  initial3DFile?: File | null;
  onClose3DLayer?: () => void;
  onInsertRasterLayer?: (layer: LayerItem, canvas: HTMLCanvasElement) => void;
  onBake3DSuccess?: (layer: LayerItem) => void;
  liquifySettings?: LiquifySettings;
  onUpdateLiquifySettings?: (newSettings: Partial<LiquifySettings>) => void;
  primaryColor?: string;
  onSwapColors?: () => void;
  showCursorCoordinates?: boolean;
  showPressureInStatusBar?: boolean;
  isWebtoonMode?: boolean;
  onToggleWebtoonMode?: () => void;
  onOpenWebtoonExport?: () => void;
  activeBalloon?: SpeechBalloon | null;
  onUpdateBalloon?: (updater: (prev: SpeechBalloon) => SpeechBalloon) => void;
  onConfirmBalloon?: () => void;
  onDeleteBalloon?: () => void;
  frameDragPreview?: { mode: 'create' | 'divide'; start: { x: number; y: number }; end: { x: number; y: number } } | null;
  shapeDragPreview?: ShapeDragPreview | null;
  gradientDragPreview?: GradientDragPreview | null;
  gradientMesh?: GradientMeshState | null;
  gradientSettings?: GradientSettings;
  onApplyGradientMesh?: () => void;
  onCancelGradientMesh?: () => void;
  retouchSettings?: RetouchSettings;
  onUpdateRetouchSettings?: (newSettings: Partial<RetouchSettings>) => void;
  cloneSourceIndicator?: CloneSourceIndicator | null;
  penSession?: PenPathSession | null;
  penSettings?: PenToolSettings;
  onCommitPenPath?: () => void;
  onCancelPenPath?: () => void;
  onToggleClosePenPath?: () => void;
  secondaryColor?: string;
  animationTimeline?: AnimationTimelineType | null;
  onUpdateAnimationTimeline?: (timeline: AnimationTimelineType) => void;
  onAddAnimationCel?: (frameIndex: number) => void;
  onDeleteAnimationCel?: (frameIndex: number) => void;
  onSelectCelLayer?: (layerId: string) => void;
  softProofSettings?: SoftProofSettings;
  onViewportReady?: (viewport: HTMLDivElement) => void;
  activeLayerId?: string;
  colorMode?: CanvasColorMode;
  tileGrid?: SparseTileGrid;
  isExternalFileDropActive?: boolean;
}

export interface CursorConfig {
  activeToolSize: number;
  tipAspect: number;
  thicknessRatio: number;
  thicknessVertical: boolean;
  tipAngleDeg: number;
  followDirection?: boolean;
  dynamicDirDeg?: number;
  rotation: number;
  flipX: boolean;
  flipY: boolean;
}

export interface CursorStyleParams {
  isOverCanvas: boolean;
  isResizingBrush: boolean;
  heldModifierAction: ModifierAction;
  isZoomDragging: boolean;
  isRotating: boolean;
  isRotateModifier: boolean;
  isPanning: boolean;
  isSpaceDown: boolean;
  tool: ToolType;
}

export function extractCoalescedEvents(e: React.PointerEvent<HTMLElement>): PointerEvent[] {
  const native = e.nativeEvent;
  if (!native) return [];
  // Per W3C Pointer Events spec, pointerdown represents a single contact event;
  // some Windows/WebView2 stylus drivers emit stale or DPI-offset coalesced packets on pointerdown.
  if (native.type === 'pointerdown') {
    return [native];
  }
  if (typeof native.getCoalescedEvents === 'function') {
    try {
      const coalesced = native.getCoalescedEvents();
      if (coalesced && coalesced.length > 0) {
        const last = coalesced[coalesced.length - 1];
        // Guard against Chromium/WebView2 Windows Ink DPI coordinate-space mismatch where
        // getCoalescedEvents() diverges from the dispatching PointerEvent's clientX/clientY.
        if (
          last &&
          Number.isFinite(last.clientX) &&
          Number.isFinite(last.clientY) &&
          Math.hypot(last.clientX - native.clientX, last.clientY - native.clientY) <= 1.5
        ) {
          return coalesced as unknown as PointerEvent[];
        }
      }
    } catch {}
  }
  return [native];
}

export function extractPredictedEvents(e: React.PointerEvent<HTMLElement>): PointerEvent[] {
  const native = e.nativeEvent;
  if (native && typeof native.getPredictedEvents === 'function') {
    try {
      const predicted = native.getPredictedEvents();
      if (predicted && predicted.length > 0) {
        return predicted as unknown as PointerEvent[];
      }
    } catch {}
  }
  return [];
}

export function formatArtboardTransform(
  pan: { x: number; y: number },
  zoom: number,
  rotation: number,
  flipX: boolean,
  flipY: boolean,
  dimensions: CanvasDimensions
): string {
  const sx = (flipX ? -1 : 1) * zoom;
  const sy = (flipY ? -1 : 1) * zoom;
  return `translate3d(${pan.x}px, ${pan.y}px, 0) rotate(${rotation}deg) scale(${sx}, ${sy}) translate3d(${-dimensions.width / 2}px, ${-dimensions.height / 2}px, 0)`;
}

export function formatCursorRingTransform(
  x: number,
  y: number,
  rotation: number,
  flipX: boolean,
  flipY: boolean,
  tipAngleDeg: number
): string {
  const fx = flipX ? -1 : 1;
  const fy = flipY ? -1 : 1;
  return `translate3d(${x}px, ${y}px, 0) translate(-50%, -50%) rotate(${rotation}deg) scale(${fx}, ${fy}) rotate(${tipAngleDeg}deg)`;
}

export function getCursorStyle({
  isOverCanvas,
  isResizingBrush,
  heldModifierAction,
  isZoomDragging,
  isRotating,
  isRotateModifier,
  isPanning,
  isSpaceDown,
  tool,
}: CursorStyleParams): React.CSSProperties {
  if (isResizingBrush || heldModifierAction === 'brush-size') {
    return { cursor: 'ew-resize' };
  }
  if (isZoomDragging || heldModifierAction === 'zoom-drag') {
    return { cursor: 'zoom-in' };
  }
  if (isRotating || isRotateModifier || heldModifierAction === 'rotate') {
    return { cursor: ROTATE_CURSOR_CSS };
  }
  if (isPanning) {
    return { cursor: 'grabbing' };
  }
  if (isSpaceDown || heldModifierAction === 'pan') {
    return { cursor: 'grab' };
  }
  if (tool === 'pipette' || heldModifierAction === 'eyedropper') {
    return { cursor: PIPETTE_CURSOR_CSS };
  }
  if (tool === 'text') {
    return { cursor: 'text' };
  }
  if (
    tool === 'select-rect' ||
    tool === 'select-lasso' ||
    tool === 'select-wand' ||
    tool === 'fill' ||
    tool === 'gradient' ||
    tool === 'frame' ||
    tool === 'shape' ||
    tool === 'pen'
  ) {
    return { cursor: 'crosshair' };
  }
  if (tool === 'liquify' || tool === 'retouch') {
    return { cursor: isOverCanvas ? 'none' : 'default' };
  }
  if (tool === 'transform' || tool === '3d') {
    return { cursor: 'default' };
  }
  if (tool === 'brush' || tool === 'eraser' || tool === 'select-pen' || tool === 'select-eraser') {
    return { cursor: isOverCanvas ? 'none' : 'default' };
  }
  return { cursor: isOverCanvas ? 'crosshair' : 'default' };
}
