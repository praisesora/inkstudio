import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Plus,
  ChevronLeft,
  ChevronRight,
  Trash2,
  ZoomIn,
  ZoomOut,
  Maximize,
  RotateCcw,
  RotateCw,
  FlipHorizontal,
  Pipette,
  Hand,
  List,
  ImagePlus,
  RefreshCw,
} from 'lucide-react';
import { CanvasColorMode } from '../types/editor';
import { ThemePreset } from '../types/settings';
import {
  SUB_VIEW_MAX_ZOOM,
  SUB_VIEW_MIN_ZOOM,
  SubViewImageItem,
  SubViewTransform,
  hydrateSubViewImages,
  subViewStoreActions,
  useSubViewStore,
} from '../stores/useSubViewStore';
import { toolStoreActions } from '../stores/useToolStore';

const DND_PANEL_MIME = 'application/x-inkstudio-panel';
const VALID_IMAGE_EXT_RE = /\.(png|jpe?g|webp|gif|bmp|avif|ico|svg)$/i;

export interface PixelCoord {
  x: number;
  y: number;
}

/**
 * Inverse-maps a point `(localX, localY)` inside the Sub View stage into
 * integer source image pixel coordinates `(x, y)` accounting for pan, zoom, rotation, and flipX.
 * Returns `null` if the point lies outside the image bounds.
 */
export function subViewPointToImagePixel(
  localX: number,
  localY: number,
  stageW: number,
  stageH: number,
  imgW: number,
  imgH: number,
  transform: SubViewTransform
): PixelCoord | null {
  if (imgW <= 0 || imgH <= 0 || stageW <= 0 || stageH <= 0) return null;
  const safeZoom = Math.max(1e-4, transform.zoom);
  const dx = localX - (stageW / 2 + transform.pan.x);
  const dy = localY - (stageH / 2 + transform.pan.y);

  const rad = (transform.rotation * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);

  const unrotX = dx * cos + dy * sin;
  const unrotY = -dx * sin + dy * cos;
  const fx = transform.flipX ? -1 : 1;

  const px = Math.floor(imgW / 2 + (fx * unrotX) / safeZoom);
  const py = Math.floor(imgH / 2 + unrotY / safeZoom);

  if (px < 0 || py < 0 || px >= imgW || py >= imgH) return null;
  return { x: px, y: py };
}

/**
 * Safely samples a `#rrggbb` hex color at `(px, py)` from an owned offscreen 2D canvas.
 * Catches CORS/SecurityError exceptions cleanly and ignores fully transparent pixels.
 */
export function samplePixelHexFromCanvas(
  canvas: HTMLCanvasElement | null,
  px: number,
  py: number
): string | null {
  if (!canvas || px < 0 || py < 0 || px >= canvas.width || py >= canvas.height) {
    return null;
  }
  try {
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) return null;
    const data = ctx.getImageData(px, py, 1, 1).data;
    const alpha = data[3];
    if (alpha === 0) return null;
    const r = data[0].toString(16).padStart(2, '0');
    const g = data[1].toString(16).padStart(2, '0');
    const b = data[2].toString(16).padStart(2, '0');
    return `#${r}${g}${b}`;
  } catch {
    // Guard against tainted canvas / SecurityError
    return null;
  }
}

export function computeSubViewFitZoom(
  stageW: number,
  stageH: number,
  imgW: number,
  imgH: number,
  padding = 12
): number {
  if (imgW <= 0 || imgH <= 0 || stageW <= 0 || stageH <= 0) return 1;
  const availW = Math.max(16, stageW - padding * 2);
  const availH = Math.max(16, stageH - padding * 2);
  const fit = Math.min(availW / imgW, availH / imgH);
  return Math.max(SUB_VIEW_MIN_ZOOM, Math.min(SUB_VIEW_MAX_ZOOM, fit));
}

function isImageFile(file: File): boolean {
  if (file.type && file.type.startsWith('image/')) return true;
  return VALID_IMAGE_EXT_RE.test(file.name);
}

function readLocalImageFile(file: File): Promise<{ name: string; src: string; width: number; height: number }> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error(`Failed to read ${file.name}`));
    reader.onload = () => {
      const dataUrl = typeof reader.result === 'string' ? reader.result : '';
      if (!dataUrl) {
        reject(new Error(`Empty image data for ${file.name}`));
        return;
      }
      const img = new Image();
      img.onload = () => {
        resolve({
          name: file.name || 'Reference',
          src: dataUrl,
          width: img.naturalWidth || img.width || 1,
          height: img.naturalHeight || img.height || 1,
        });
      };
      img.onerror = () => reject(new Error(`Unsupported image format: ${file.name}`));
      img.src = dataUrl;
    };
    reader.readAsDataURL(file);
  });
}

export interface SubViewPanelProps {
  colorMode?: CanvasColorMode;
  themePreset?: ThemePreset;
}

export const SubViewPanel: React.FC<SubViewPanelProps> = React.memo(
  ({ colorMode = 'color', themePreset = 'modern' }) => {

    const items = useSubViewStore((s) => s.items);
    const activeId = useSubViewStore((s) => s.activeId);
    const autoEyedropper = useSubViewStore((s) => s.autoEyedropper);
    const manualEyedropper = useSubViewStore((s) => s.manualEyedropper);
    const showList = useSubViewStore((s) => s.showList);

    const activeIndex = useMemo(
      () => Math.max(0, items.findIndex((i) => i.id === activeId)),
      [items, activeId]
    );
    const activeItem: SubViewImageItem | null = items.length > 0 ? items[activeIndex] ?? items[0] : null;

    const stageRef = useRef<HTMLDivElement | null>(null);
    const displayCanvasRef = useRef<HTMLCanvasElement | null>(null);
    const sourceCanvasRef = useRef<HTMLCanvasElement | null>(null);
    const fileInputRef = useRef<HTMLInputElement | null>(null);
    const reloadInputRef = useRef<HTMLInputElement | null>(null);

    const [stageSize, setStageSize] = useState<{ width: number; height: number }>({
      width: 200,
      height: 140,
    });
    const [sourceVersion, setSourceVersion] = useState(0);
    const [isDragOverFiles, setIsDragOverFiles] = useState(false);
    const [isHoveringStage, setIsHoveringStage] = useState(false);
    const [isSpaceHeld, setIsSpaceHeld] = useState(false);
    const [isAltHeld, setIsAltHeld] = useState(false);
    const [sampledHex, setSampledHex] = useState<string | null>(null);
    const [loadError, setLoadError] = useState<string | null>(null);

    // Live mutable transform during drag/pan/wheel so Sub View stays silky-smooth
    const liveTransformRef = useRef<SubViewTransform>({
      zoom: 1,
      pan: { x: 0, y: 0 },
      rotation: 0,
      flipX: false,
    });

    const interactionRef = useRef<{
      mode: 'none' | 'pan' | 'eyedrop';
      pointerId: number | null;
      startClientX: number;
      startClientY: number;
      startPanX: number;
      startPanY: number;
    }>({
      mode: 'none',
      pointerId: null,
      startClientX: 0,
      startClientY: 0,
      startPanX: 0,
      startPanY: 0,
    });

    const activeItemRef = useRef<SubViewImageItem | null>(activeItem);
    activeItemRef.current = activeItem;

    const stageSizeRef = useRef(stageSize);
    stageSizeRef.current = stageSize;

    // Hydrate Sub View image data URLs from IndexedDB on mount
    useEffect(() => {
      void hydrateSubViewImages();
    }, []);

    // Sync live transform ref whenever active item changes
    useEffect(() => {
      if (!activeItem) return;
      liveTransformRef.current = {
        zoom: activeItem.zoom,
        pan: { x: activeItem.pan.x, y: activeItem.pan.y },
        rotation: activeItem.rotation,
        flipX: activeItem.flipX,
      };
    }, [activeItem]);

    // Track stage dimensions via ResizeObserver
    useEffect(() => {
      const el = stageRef.current;
      if (!el) return;
      const sync = () => {
        const rect = el.getBoundingClientRect();
        if (rect.width > 0 && rect.height > 0) {
          setStageSize((prev) =>
            Math.abs(prev.width - rect.width) < 1 && Math.abs(prev.height - rect.height) < 1
              ? prev
              : { width: Math.round(rect.width), height: Math.round(rect.height) }
          );
        }
      };
      sync();
      const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(sync) : null;
      ro?.observe(el);
      return () => ro?.disconnect();
    }, []);

    // Track Space / Alt while hovering Sub View for quick pan/eyedropper override
    useEffect(() => {
      if (!isHoveringStage) {
        setIsSpaceHeld(false);
        setIsAltHeld(false);
        return;
      }
      const onKeyDown = (e: KeyboardEvent) => {
        if (e.code === 'Space' || e.key === ' ') setIsSpaceHeld(true);
        if (e.key === 'Alt') setIsAltHeld(true);
      };
      const onKeyUp = (e: KeyboardEvent) => {
        if (e.code === 'Space' || e.key === ' ') setIsSpaceHeld(false);
        if (e.key === 'Alt') setIsAltHeld(false);
      };
      const onBlur = () => {
        setIsSpaceHeld(false);
        setIsAltHeld(false);
      };
      window.addEventListener('keydown', onKeyDown);
      window.addEventListener('keyup', onKeyUp, true);
      window.addEventListener('blur', onBlur);
      return () => {
        window.removeEventListener('keydown', onKeyDown);
        window.removeEventListener('keyup', onKeyUp, true);
        window.removeEventListener('blur', onBlur);
      };
    }, [isHoveringStage]);

    // Decode active reference into an owned offscreen 2D canvas for CORS-safe pixel sampling
    useEffect(() => {
      let cancelled = false;
      setLoadError(null);

      if (!activeItem || !activeItem.src) {
        sourceCanvasRef.current = null;
        setSourceVersion((v) => v + 1);
        return;
      }

      const img = new Image();
      img.crossOrigin = 'anonymous';
      img.onload = () => {
        if (cancelled) return;
        const w = Math.max(1, img.naturalWidth || img.width || activeItem.width || 1);
        const h = Math.max(1, img.naturalHeight || img.height || activeItem.height || 1);
        const off = document.createElement('canvas');
        off.width = w;
        off.height = h;
        const ctx = off.getContext('2d', { willReadFrequently: true });
        if (ctx) {
          ctx.clearRect(0, 0, w, h);
          ctx.drawImage(img, 0, 0, w, h);
        }
        sourceCanvasRef.current = off;
        setSourceVersion((v) => v + 1);

        if (activeItem.needsInitialFit) {
          const { width: sw, height: sh } = stageSizeRef.current;
          const fitZoom = computeSubViewFitZoom(sw, sh, w, h);
          liveTransformRef.current = { zoom: fitZoom, pan: { x: 0, y: 0 }, rotation: 0, flipX: false };
          subViewStoreActions.updateImageTransform(
            activeItem.id,
            { zoom: fitZoom, pan: { x: 0, y: 0 }, rotation: 0, flipX: false, needsInitialFit: false },
            true
          );
        }
      };
      img.onerror = () => {
        if (cancelled) return;
        sourceCanvasRef.current = null;
        setLoadError('Failed to decode image');
        setSourceVersion((v) => v + 1);
      };
      img.src = activeItem.src;

      return () => {
        cancelled = true;
      };
    }, [activeItem?.id, activeItem?.src]);

    // Render Sub View display canvas from owned offscreen source canvas
    const renderDisplayCanvas = useCallback(
      (overrideTransform?: SubViewTransform) => {
        const display = displayCanvasRef.current;
        if (!display) return;
        const ctx = display.getContext('2d');
        if (!ctx) return;

        const { width: sw, height: sh } = stageSizeRef.current;
        const dpr = typeof window !== 'undefined' ? Math.min(2, window.devicePixelRatio || 1) : 1;
        const targetW = Math.max(1, Math.round(sw * dpr));
        const targetH = Math.max(1, Math.round(sh * dpr));
        if (display.width !== targetW || display.height !== targetH) {
          display.width = targetW;
          display.height = targetH;
        }

        ctx.save();
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        ctx.clearRect(0, 0, sw, sh);

        const src = sourceCanvasRef.current;
        if (!src) {
          ctx.restore();
          return;
        }

        const t = overrideTransform ?? liveTransformRef.current;
        ctx.translate(sw / 2 + t.pan.x, sh / 2 + t.pan.y);
        ctx.rotate((t.rotation * Math.PI) / 180);
        ctx.scale(t.flipX ? -t.zoom : t.zoom, t.zoom);
        ctx.imageSmoothingEnabled = t.zoom < 2;
        ctx.drawImage(src, -src.width / 2, -src.height / 2);
        ctx.restore();
      },
      []
    );

    useEffect(() => {
      renderDisplayCanvas();
    }, [activeItem, stageSize, sourceVersion, renderDisplayCanvas]);

    // Determine effective interaction mode on hover/click
    const isEyedropperActive = useMemo(() => {
      if (isSpaceHeld) return false;
      if (isAltHeld) return true;
      return autoEyedropper || manualEyedropper;
    }, [autoEyedropper, manualEyedropper, isSpaceHeld, isAltHeld]);

    const sampleColorAtClientPos = useCallback(
      (clientX: number, clientY: number, commit: boolean): string | null => {
        const stage = stageRef.current;
        const src = sourceCanvasRef.current;
        if (!stage || !src) return null;
        const rect = stage.getBoundingClientRect();
        const localX = clientX - rect.left;
        const localY = clientY - rect.top;
        const pxCoord = subViewPointToImagePixel(
          localX,
          localY,
          rect.width || stageSizeRef.current.width,
          rect.height || stageSizeRef.current.height,
          src.width,
          src.height,
          liveTransformRef.current
        );
        if (!pxCoord) return null;
        const hex = samplePixelHexFromCanvas(src, pxCoord.x, pxCoord.y);
        if (!hex) return null;
        setSampledHex(hex);
        toolStoreActions.setPrimaryColor(hex, commit, colorMode);
        return hex;
      },
      [colorMode]
    );

    const handleFilesSelected = useCallback(async (fileList: FileList | File[]) => {
      const files = Array.from(fileList).filter(isImageFile);
      if (files.length === 0) return;
      setLoadError(null);
      const loaded: Array<{ name: string; src: string; width: number; height: number }> = [];
      for (const file of files) {
        try {
          loaded.push(await readLocalImageFile(file));
        } catch {
          setLoadError(`Could not load "${file.name}"`);
        }
      }
      if (loaded.length > 0) {
        subViewStoreActions.addImages(loaded);
      }
    }, []);

    const handleReloadActiveFile = useCallback(async (file: File | undefined) => {
      const item = activeItemRef.current;
      if (!file || !item || !isImageFile(file)) return;
      try {
        const loaded = await readLocalImageFile(file);
        subViewStoreActions.replaceImageSrc(item.id, loaded.src, loaded.width, loaded.height);
      } catch {
        setLoadError(`Could not load "${file.name}"`);
      }
    }, []);

    const handleStagePointerDown = useCallback(
      (e: React.PointerEvent<HTMLDivElement>) => {
        const item = activeItemRef.current;
        if (!item || !item.src) return;
        e.preventDefault();
        e.stopPropagation();

        // Middle mouse button or Space forces pan
        const forcePan = e.button === 1 || isSpaceHeld;
        const shouldEyedrop = !forcePan && e.button === 0 && (isEyedropperActive || e.altKey);

        if (shouldEyedrop) {
          interactionRef.current = {
            mode: 'eyedrop',
            pointerId: e.pointerId,
            startClientX: e.clientX,
            startClientY: e.clientY,
            startPanX: 0,
            startPanY: 0,
          };
          sampleColorAtClientPos(e.clientX, e.clientY, true);
        } else if (e.button === 0 || e.button === 1) {
          interactionRef.current = {
            mode: 'pan',
            pointerId: e.pointerId,
            startClientX: e.clientX,
            startClientY: e.clientY,
            startPanX: liveTransformRef.current.pan.x,
            startPanY: liveTransformRef.current.pan.y,
          };
        }

        try {
          e.currentTarget.setPointerCapture?.(e.pointerId);
        } catch {
          // Ignore in synthetic events
        }
      },
      [isEyedropperActive, isSpaceHeld, sampleColorAtClientPos]
    );

    const handleStagePointerMove = useCallback(
      (e: React.PointerEvent<HTMLDivElement>) => {
        const state = interactionRef.current;
        if (state.mode === 'none') return;

        if (state.mode === 'eyedrop') {
          sampleColorAtClientPos(e.clientX, e.clientY, false);
          return;
        }

        if (state.mode === 'pan') {
          const dx = e.clientX - state.startClientX;
          const dy = e.clientY - state.startClientY;
          const next: SubViewTransform = {
            ...liveTransformRef.current,
            pan: { x: state.startPanX + dx, y: state.startPanY + dy },
          };
          liveTransformRef.current = next;
          renderDisplayCanvas(next);
        }
      },
      [renderDisplayCanvas, sampleColorAtClientPos]
    );

    const finishStageInteraction = useCallback(
      (e?: React.PointerEvent<HTMLDivElement>) => {
        const state = interactionRef.current;
        if (state.mode === 'none') return;
        const prevMode = state.mode;
        const pid = state.pointerId;
        interactionRef.current.mode = 'none';
        interactionRef.current.pointerId = null;

        if (e && pid !== null) {
          try {
            e.currentTarget.releasePointerCapture?.(pid);
          } catch {
            // Ignore in synthetic events
          }
        }

        const item = activeItemRef.current;
        if (prevMode === 'pan' && item) {
          subViewStoreActions.updateImageTransform(
            item.id,
            { pan: liveTransformRef.current.pan, needsInitialFit: false },
            true
          );
        } else if (prevMode === 'eyedrop' && e) {
          sampleColorAtClientPos(e.clientX, e.clientY, true);
        }
      },
      [sampleColorAtClientPos]
    );

    // Independent mouse wheel zoom strictly inside Sub View
    useEffect(() => {
      const el = stageRef.current;
      if (!el) return;
      const handleWheel = (e: WheelEvent) => {
        const item = activeItemRef.current;
        if (!item || !item.src) return;
        e.preventDefault();
        e.stopPropagation();

        const rect = el.getBoundingClientRect();
        const localX = e.clientX - rect.left;
        const localY = e.clientY - rect.top;
        const cx = (rect.width || stageSizeRef.current.width) / 2;
        const cy = (rect.height || stageSizeRef.current.height) / 2;

        const factor = Math.exp(-e.deltaY * 0.002);
        const cur = liveTransformRef.current;
        const nextZoom = Math.max(SUB_VIEW_MIN_ZOOM, Math.min(SUB_VIEW_MAX_ZOOM, cur.zoom * factor));
        const ratio = nextZoom / cur.zoom;

        const nextPanX = localX - cx - (localX - cx - cur.pan.x) * ratio;
        const nextPanY = localY - cy - (localY - cy - cur.pan.y) * ratio;

        const next: SubViewTransform = {
          ...cur,
          zoom: nextZoom,
          pan: { x: nextPanX, y: nextPanY },
        };
        liveTransformRef.current = next;
        renderDisplayCanvas(next);
        subViewStoreActions.updateImageTransform(
          item.id,
          { zoom: nextZoom, pan: next.pan, needsInitialFit: false },
          true
        );
      };
      el.addEventListener('wheel', handleWheel, { passive: false });
      return () => el.removeEventListener('wheel', handleWheel);
    }, [renderDisplayCanvas]);

    // Independent Sub View control actions (strictly local to active Sub View image)
    const handleSubZoomBy = useCallback((factor: number) => {
      const item = activeItemRef.current;
      if (!item) return;
      const nextZoom = Math.max(
        SUB_VIEW_MIN_ZOOM,
        Math.min(SUB_VIEW_MAX_ZOOM, liveTransformRef.current.zoom * factor)
      );
      subViewStoreActions.updateImageTransform(item.id, { zoom: nextZoom, needsInitialFit: false }, true);
    }, []);

    const handleSubFit = useCallback(() => {
      const item = activeItemRef.current;
      if (!item) return;
      const src = sourceCanvasRef.current;
      const w = src?.width || item.width || 1;
      const h = src?.height || item.height || 1;
      const { width: sw, height: sh } = stageSizeRef.current;
      const fitZoom = computeSubViewFitZoom(sw, sh, w, h);
      subViewStoreActions.updateImageTransform(
        item.id,
        { zoom: fitZoom, pan: { x: 0, y: 0 }, rotation: 0, flipX: false, needsInitialFit: false },
        true
      );
    }, []);

    const handleSubRotateBy = useCallback((deltaDeg: number) => {
      const item = activeItemRef.current;
      if (!item) return;
      subViewStoreActions.updateImageTransform(
        item.id,
        { rotation: liveTransformRef.current.rotation + deltaDeg },
        true
      );
    }, []);

    const handleSubResetRotation = useCallback(() => {
      const item = activeItemRef.current;
      if (!item) return;
      subViewStoreActions.updateImageTransform(item.id, { rotation: 0 }, true);
    }, []);

    const handleSubToggleFlipX = useCallback(() => {
      const item = activeItemRef.current;
      if (!item) return;
      subViewStoreActions.updateImageTransform(
        item.id,
        { flipX: !liveTransformRef.current.flipX },
        true
      );
    }, []);

    const handleDragOver = (e: React.DragEvent<HTMLDivElement>) => {
      // Ignore internal dock tab drag operations
      if (e.dataTransfer.types.includes(DND_PANEL_MIME)) return;
      e.preventDefault();
      e.stopPropagation();
      e.dataTransfer.dropEffect = 'copy';
      setIsDragOverFiles(true);
    };

    const handleDragLeave = () => {
      setIsDragOverFiles(false);
    };

    const handleDrop = (e: React.DragEvent<HTMLDivElement>) => {
      if (e.dataTransfer.types.includes(DND_PANEL_MIME)) return;
      e.preventDefault();
      e.stopPropagation();
      setIsDragOverFiles(false);
      if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
        void handleFilesSelected(e.dataTransfer.files);
      }
    };

    const btnBase =
      'h-5 px-1 rounded text-[10px] flex items-center justify-center text-[#a3a3a3] hover:text-[#f5f5f5] hover:bg-[#2c2c2c] disabled:opacity-35 disabled:pointer-events-none transition-colors cursor-pointer';

    const btnActive =
      'bg-[var(--accent-subtle)] text-[var(--accent)] ring-1 ring-inset ring-[var(--accent-border)]';

    const stageCursorClass = !activeItem?.src
      ? 'cursor-default'
      : isEyedropperActive
      ? 'cursor-crosshair'
      : interactionRef.current.mode === 'pan'
      ? 'cursor-grabbing'
      : 'cursor-grab';

    return (
      <div
        data-testid="sub-view-panel"
        data-theme-preset={themePreset}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
        className="flex flex-col h-full min-h-0 select-none relative bg-[#202020] text-[#e5e5e5]"
      >
        {/* Hidden Local Image Inputs */}
        <input
          ref={fileInputRef}
          data-testid="subview-file-input"
          type="file"
          accept="image/*"
          multiple
          className="hidden"
          onChange={(e) => {
            if (e.target.files && e.target.files.length > 0) {
              void handleFilesSelected(e.target.files);
            }
            e.target.value = '';
          }}
        />
        <input
          ref={reloadInputRef}
          type="file"
          accept="image/*"
          className="hidden"
          onChange={(e) => {
            void handleReloadActiveFile(e.target.files?.[0]);
            e.target.value = '';
          }}
        />

        {/* Top Bar: Reference Management (+, < >, index, list toggle, delete) */}
        <div className="h-6 px-1 flex items-center justify-between gap-1 shrink-0 border-b bg-[#1b1b1b] border-white/[0.06]">
          <div className="flex items-center gap-0.5 min-w-0">
            <button
              type="button"
              data-testid="subview-add-btn"
              onClick={() => fileInputRef.current?.click()}
              title="Import Reference Image(s)"
              className={`${btnBase} w-5 shrink-0`}
            >
              <Plus className="w-3 h-3" />
            </button>
            <button
              type="button"
              data-testid="subview-prev-btn"
              disabled={items.length <= 1}
              onClick={() => subViewStoreActions.stepActive(-1)}
              title="Previous Reference"
              className={`${btnBase} w-5 shrink-0`}
            >
              <ChevronLeft className="w-3 h-3" />
            </button>
            <span
              data-testid="subview-counter"
              className="text-[10px] font-mono tabular-nums text-[#a8a8a8] px-0.5 shrink-0"
            >
              {items.length > 0 ? `${activeIndex + 1}/${items.length}` : '0/0'}
            </span>
            <button
              type="button"
              data-testid="subview-next-btn"
              disabled={items.length <= 1}
              onClick={() => subViewStoreActions.stepActive(1)}
              title="Next Reference"
              className={`${btnBase} w-5 shrink-0`}
            >
              <ChevronRight className="w-3 h-3" />
            </button>
          </div>

          <span
            data-testid="subview-active-name"
            title={activeItem?.name || ''}
            className="text-[10px] text-[#9e9e9e] truncate flex-1 text-center px-1"
          >
            {activeItem?.name || 'No reference'}
          </span>

          <div className="flex items-center gap-0.5 shrink-0">
            <button
              type="button"
              data-testid="subview-list-toggle"
              disabled={items.length === 0}
              onClick={() => subViewStoreActions.toggleShowList()}
              aria-pressed={showList}
              title="Reference List"
              className={`${btnBase} w-5 ${showList && items.length > 0 ? btnActive : ''}`}
            >
              <List className="w-3 h-3" />
            </button>
            <button
              type="button"
              data-testid="subview-delete-btn"
              disabled={!activeItem}
              onClick={() => activeItem && subViewStoreActions.removeImage(activeItem.id)}
              title="Remove Current Reference"
              className={`${btnBase} w-5 hover:text-rose-400`}
            >
              <Trash2 className="w-3 h-3" />
            </button>
          </div>
        </div>

        {/* Optional Reference List Strip */}
        {showList && items.length > 0 && (
          <div
            data-testid="subview-list-drawer"
            className="max-h-24 overflow-y-auto shrink-0 border-b px-1 py-0.5 flex flex-col gap-0.5 bg-[#181818] border-white/[0.06]"
          >
            {items.map((item, idx) => {
              const isSelected = item.id === activeItem?.id;
              return (
                <div
                  key={item.id}
                  data-testid={`subview-list-item-${item.id}`}
                  onClick={() => subViewStoreActions.selectImage(item.id)}
                  className={`flex items-center gap-1.5 px-1 py-0.5 rounded text-[10px] cursor-pointer ${
                    isSelected
                      ? 'bg-[#2c2c2c] text-[#f5f5f5]'
                      : 'text-[#a3a3a3] hover:bg-[#242424]'
                  }`}
                >
                  {item.src ? (
                    <img
                      src={item.src}
                      alt=""
                      className="w-4 h-4 object-cover rounded-sm shrink-0 bg-[#111]"
                    />
                  ) : (
                    <div className="w-4 h-4 rounded-sm shrink-0 bg-[#2a2a2a] flex items-center justify-center text-[8px]">
                      {idx + 1}
                    </div>
                  )}
                  <span className="truncate flex-1">{item.name}</span>
                  <span className="text-[9px] opacity-60 font-mono shrink-0">
                    {item.width}x{item.height}
                  </span>
                </div>
              );
            })}
          </div>
        )}

        {/* Reference Viewport Stage */}
        <div
          ref={stageRef}
          data-testid="subview-stage"
          onPointerEnter={() => setIsHoveringStage(true)}
          onPointerLeave={() => {
            setIsHoveringStage(false);
            setSampledHex(null);
          }}
          onPointerDown={handleStagePointerDown}
          onPointerMove={handleStagePointerMove}
          onPointerUp={finishStageInteraction}
          onPointerCancel={finishStageInteraction}
          className={`relative flex-1 min-h-[76px] overflow-hidden flex items-center justify-center ${stageCursorClass} ${
            isDragOverFiles
              ? 'ring-2 ring-inset ring-[var(--accent)] bg-[var(--accent-subtle)]'
              : 'bg-[#141414]'
          }`}
        >
          <canvas
            ref={displayCanvasRef}
            data-testid="subview-canvas"
            className="absolute inset-0 w-full h-full pointer-events-none"
          />

          {/* Empty State / Drop Target */}
          {!activeItem && (
            <button
              type="button"
              data-testid="subview-empty-dropzone"
              onClick={() => fileInputRef.current?.click()}
              className="z-10 flex flex-col items-center gap-1 px-3 py-2 rounded border border-dashed border-white/[0.15] hover:border-[var(--accent)] text-[#8a8a8a] hover:text-[#e5e5e5] transition-colors cursor-pointer"
            >
              <ImagePlus className="w-4 h-4 opacity-75" />
              <span className="text-[10px]">Drop images or click +</span>
            </button>
          )}

          {/* Persisted Metadata-Only Slot (image exceeded localStorage budget) */}
          {activeItem && !activeItem.src && (
            <div className="z-10 flex flex-col items-center gap-1 px-2 text-center">
              <span className="text-[10px] text-[#9e9e9e]">
                {activeItem.name} (reload file)
              </span>
              <button
                type="button"
                onClick={() => reloadInputRef.current?.click()}
                className="h-5 px-2 rounded bg-[#2c2c2c] hover:bg-[#383838] text-[10px] text-[#e5e5e5] flex items-center gap-1 cursor-pointer"
              >
                <RefreshCw className="w-3 h-3" />
                <span>Re-open</span>
              </button>
            </div>
          )}

          {/* Error Pill */}
          {loadError && (
            <div className="absolute bottom-1 left-1 right-1 z-20 px-1.5 py-0.5 rounded bg-rose-950/90 border border-rose-500/40 text-[9px] text-rose-200 truncate">
              {loadError}
            </div>
          )}

          {/* Live Sampled Color Swatch Pill */}
          {sampledHex && (
            <div
              data-testid="subview-sampled-pill"
              className="absolute top-1 right-1 z-20 px-1.5 py-0.5 rounded bg-[#161616]/90 border border-white/15 flex items-center gap-1 pointer-events-none shadow"
            >
              <span
                className="w-2.5 h-2.5 rounded-sm border border-white/30 shrink-0"
                style={{ backgroundColor: sampledHex }}
              />
              <span className="text-[9px] font-mono text-[#e5e5e5] uppercase">{sampledHex}</span>
            </div>
          )}
        </div>

        {/* Bottom Compact Control Bar (Strictly Local Sub View Transforms + Eyedropper Mode) */}
        <div className="shrink-0 px-1.5 py-1 flex items-center justify-between gap-0.5 flex-wrap border-t bg-[#1b1b1b] border-white/[0.06]">
          {/* Zoom + Fit */}
          <div className="flex items-center gap-0.5">
            <button
              type="button"
              data-testid="subview-zoom-out"
              disabled={!activeItem}
              onClick={() => handleSubZoomBy(1 / 1.25)}
              title="Sub View Zoom Out"
              className={`${btnBase} w-5`}
            >
              <ZoomOut className="w-3 h-3" />
            </button>
            <button
              type="button"
              data-testid="subview-zoom-in"
              disabled={!activeItem}
              onClick={() => handleSubZoomBy(1.25)}
              title="Sub View Zoom In"
              className={`${btnBase} w-5`}
            >
              <ZoomIn className="w-3 h-3" />
            </button>
            <button
              type="button"
              data-testid="subview-fit"
              disabled={!activeItem}
              onClick={handleSubFit}
              title="Reset Sub View (Fit, 0°, Unflip)"
              className={`${btnBase} w-5`}
            >
              <Maximize className="w-3 h-3" />
            </button>
          </div>

          {/* Rotate + Flip H */}
          <div className="flex items-center gap-0.5">
            <button
              type="button"
              data-testid="subview-rotate-left"
              disabled={!activeItem}
              onClick={() => handleSubRotateBy(-15)}
              title="Sub View Rotate Left (-15°)"
              className={`${btnBase} w-5`}
            >
              <RotateCcw className="w-3 h-3" />
            </button>
            <button
              type="button"
              data-testid="subview-reset-rotation"
              disabled={!activeItem}
              onClick={handleSubResetRotation}
              title="Reset Sub View Rotation (0°)"
              className={`${btnBase} px-1 font-mono tabular-nums`}
            >
              {`${Math.round(activeItem?.rotation ?? 0)}°`}
            </button>
            <button
              type="button"
              data-testid="subview-rotate-right"
              disabled={!activeItem}
              onClick={() => handleSubRotateBy(15)}
              title="Sub View Rotate Right (+15°)"
              className={`${btnBase} w-5`}
            >
              <RotateCw className="w-3 h-3" />
            </button>
            <button
              type="button"
              data-testid="subview-flip-h"
              disabled={!activeItem}
              aria-pressed={Boolean(activeItem?.flipX)}
              onClick={handleSubToggleFlipX}
              title="Sub View Flip Horizontal"
              className={`${btnBase} w-5 ${activeItem?.flipX ? btnActive : ''}`}
            >
              <FlipHorizontal className="w-3 h-3" />
            </button>
          </div>

          {/* Eyedropper / Pan Mode Controls */}
          <div className="flex items-center gap-0.5">
            <button
              type="button"
              data-testid="subview-auto-eyedropper"
              aria-pressed={autoEyedropper}
              onClick={() => subViewStoreActions.toggleAutoEyedropper()}
              title="Switch to Eyedropper Automatically on Hover/Click (CSP mode)"
              className={`${btnBase} gap-0.5 px-1 ${autoEyedropper ? btnActive : ''}`}
            >
              <Pipette className="w-3 h-3" />
              <span>Auto</span>
            </button>
            {!autoEyedropper && (
              <button
                type="button"
                data-testid="subview-mode-toggle"
                aria-pressed={manualEyedropper}
                onClick={() => subViewStoreActions.setManualEyedropper(!manualEyedropper)}
                title={manualEyedropper ? 'Eyedropper Active (click for Pan)' : 'Pan Active (click for Eyedropper)'}
                className={`${btnBase} w-5 ${manualEyedropper ? btnActive : ''}`}
              >
                {manualEyedropper ? <Pipette className="w-3 h-3" /> : <Hand className="w-3 h-3" />}
              </button>
            )}
          </div>
        </div>
      </div>
    );
  }
);

SubViewPanel.displayName = 'SubViewPanel';
