import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ExternalFileDropTarget,
  LayerInsertTarget,
  MAX_DROPPED_IMAGE_FILES,
  filterDroppedImageFiles,
  filterDroppedImagePaths,
  isExternalFileDrag,
  isSameDropTarget,
  isSupportedImageExtension,
  readTauriDroppedImageFile,
  resolveDropZoneAtPoint,
  resolveDropZoneFromElement,
} from '../utils/fileDropImport';

interface TauriWindow extends Window {
  __TAURI_INTERNALS__?: unknown;
}

export interface UseExternalFileDropOptions {
  enabled: boolean;
  importImageFileAsLayer: (
    file: File,
    insertTarget?: LayerInsertTarget
  ) => Promise<{ id: string; name: string }>;
  onMarkDirty: () => void;
  showToast: (message: string) => void;
}

export interface UseExternalFileDropResult {
  activeDropTarget: ExternalFileDropTarget | null;
  importDroppedFiles: (files: Iterable<File>, target?: LayerInsertTarget) => Promise<number>;
}

export function useExternalFileDrop({
  enabled,
  importImageFileAsLayer,
  onMarkDirty,
  showToast,
}: UseExternalFileDropOptions): UseExternalFileDropResult {
  const [activeDropTarget, setActiveDropTarget] = useState<ExternalFileDropTarget | null>(null);
  const activeDropTargetRef = useRef<ExternalFileDropTarget | null>(null);
  const tauriDragHasImagesRef = useRef<boolean>(true);

  const updateDropTarget = useCallback((next: ExternalFileDropTarget | null) => {
    if (isSameDropTarget(activeDropTargetRef.current, next)) return;
    activeDropTargetRef.current = next;
    setActiveDropTarget(next);
  }, []);

  const importDroppedFiles = useCallback(
    async (rawFiles: Iterable<File>, target?: LayerInsertTarget): Promise<number> => {
      const { accepted, rejectedCount, oversizedCount, truncatedCount } =
        filterDroppedImageFiles(rawFiles);

      if (accepted.length === 0) {
        if (oversizedCount > 0) {
          showToast('Image exceeds 100 MB limit.');
        } else if (rejectedCount > 0) {
          showToast('Unsupported file type. Drop PNG, JPG, WebP, GIF, BMP, or SVG images.');
        }
        return 0;
      }

      const importedNames: string[] = [];
      let failedCount = 0;

      // Import in reverse order so the first dropped file lands at the top and stays active.
      let currentTarget: LayerInsertTarget | undefined = target;
      for (let i = accepted.length - 1; i >= 0; i--) {
        const file = accepted[i];
        try {
          const created = await importImageFileAsLayer(file, currentTarget);
          importedNames.unshift(created.name);
          currentTarget = { targetLayerId: created.id, position: 'above' };
        } catch (err) {
          failedCount++;
          console.warn('Dropped image import failed:', err);
        }
      }

      if (importedNames.length > 0) {
        onMarkDirty();
      }

      const skippedTotal = rejectedCount + oversizedCount + failedCount;
      if (importedNames.length === 1 && skippedTotal === 0 && truncatedCount === 0) {
        showToast(`Imported "${importedNames[0]}" as layer`);
      } else if (importedNames.length > 0) {
        const notes: string[] = [];
        if (skippedTotal > 0) notes.push(`${skippedTotal} skipped`);
        if (truncatedCount > 0) notes.push(`max ${MAX_DROPPED_IMAGE_FILES} per drop`);
        const suffix = notes.length > 0 ? ` (${notes.join(', ')})` : '';
        showToast(
          `Imported ${importedNames.length} image${importedNames.length === 1 ? '' : 's'} as layer${
            importedNames.length === 1 ? '' : 's'
          }${suffix}`
        );
      } else {
        showToast('Failed to import dropped image.');
      }

      return importedNames.length;
    },
    [importImageFileAsLayer, onMarkDirty, showToast]
  );

  const importDroppedPaths = useCallback(
    async (paths: readonly string[], target?: LayerInsertTarget): Promise<number> => {
      const { accepted, rejectedCount, truncatedCount } = filterDroppedImagePaths(paths);
      if (accepted.length === 0) {
        if (rejectedCount > 0) {
          showToast('Unsupported file type. Drop PNG, JPG, WebP, GIF, BMP, or SVG images.');
        }
        return 0;
      }

      const settled = await Promise.allSettled(
        accepted.map((p) => readTauriDroppedImageFile(p))
      );

      const files: File[] = [];
      let readFailedCount = 0;
      for (const result of settled) {
        if (result.status === 'fulfilled') {
          files.push(result.value);
        } else {
          readFailedCount++;
          console.warn('Failed to read dropped file from disk:', result.reason);
        }
      }

      if (files.length === 0) {
        showToast('Failed to read dropped image file.');
        return 0;
      }

      const importedNames: string[] = [];
      let decodeFailedCount = 0;
      let currentTarget: LayerInsertTarget | undefined = target;
      for (let i = files.length - 1; i >= 0; i--) {
        try {
          const created = await importImageFileAsLayer(files[i], currentTarget);
          importedNames.unshift(created.name);
          currentTarget = { targetLayerId: created.id, position: 'above' };
        } catch (err) {
          decodeFailedCount++;
          console.warn('Failed to decode dropped image:', err);
        }
      }

      if (importedNames.length > 0) {
        onMarkDirty();
      }

      const skippedTotal = rejectedCount + readFailedCount + decodeFailedCount;
      if (importedNames.length === 1 && skippedTotal === 0 && truncatedCount === 0) {
        showToast(`Imported "${importedNames[0]}" as layer`);
      } else if (importedNames.length > 0) {
        const notes: string[] = [];
        if (skippedTotal > 0) notes.push(`${skippedTotal} skipped`);
        if (truncatedCount > 0) notes.push(`max ${MAX_DROPPED_IMAGE_FILES} per drop`);
        const suffix = notes.length > 0 ? ` (${notes.join(', ')})` : '';
        showToast(
          `Imported ${importedNames.length} image${importedNames.length === 1 ? '' : 's'} as layer${
            importedNames.length === 1 ? '' : 's'
          }${suffix}`
        );
      } else {
        showToast('Failed to import dropped image.');
      }

      return importedNames.length;
    },
    [importImageFileAsLayer, onMarkDirty, showToast]
  );

  // Clear highlight whenever feature disables (e.g., switching to Home view or closing doc)
  useEffect(() => {
    if (!enabled) {
      updateDropTarget(null);
    }
  }, [enabled, updateDropTarget]);

  // 1. HTML5 Drag-and-Drop listener (Browser / Web / Dev / Tests)
  useEffect(() => {
    if (!enabled || typeof window === 'undefined') return;

    const resolveFromDragEvent = (e: DragEvent): ExternalFileDropTarget | null => {
      const targetEl = e.target instanceof Element ? e.target : null;
      return (
        resolveDropZoneAtPoint(e.clientX, e.clientY) ??
        resolveDropZoneFromElement(targetEl, e.clientY)
      );
    };

    const handleDragOver = (e: DragEvent) => {
      if (!isExternalFileDrag(e.dataTransfer)) return;
      const targetEl = e.target instanceof Element ? e.target : null;
      if (targetEl?.closest('[data-testid="sub-view-panel"]')) {
        updateDropTarget(null);
        return;
      }

      e.preventDefault();
      const resolved = resolveFromDragEvent(e);
      if (e.dataTransfer) {
        e.dataTransfer.dropEffect = resolved ? 'copy' : 'none';
      }
      updateDropTarget(resolved);
    };

    const handleDragLeave = (e: DragEvent) => {
      if (!activeDropTargetRef.current) return;
      if (
        e.relatedTarget === null ||
        e.clientX <= 0 ||
        e.clientY <= 0 ||
        e.clientX >= window.innerWidth ||
        e.clientY >= window.innerHeight
      ) {
        updateDropTarget(null);
      }
    };

    const handleDrop = (e: DragEvent) => {
      if (!isExternalFileDrag(e.dataTransfer)) return;
      const targetEl = e.target instanceof Element ? e.target : null;
      if (targetEl?.closest('[data-testid="sub-view-panel"]')) {
        updateDropTarget(null);
        return;
      }

      e.preventDefault();
      const resolved = resolveFromDragEvent(e) ?? activeDropTargetRef.current;
      updateDropTarget(null);

      if (!resolved) return;
      const files = e.dataTransfer?.files;
      if (!files || files.length === 0) return;

      void importDroppedFiles(Array.from(files), {
        targetLayerId: resolved.targetLayerId,
        position: resolved.position,
      });
    };

    window.addEventListener('dragover', handleDragOver);
    window.addEventListener('dragleave', handleDragLeave);
    window.addEventListener('drop', handleDrop);
    return () => {
      window.removeEventListener('dragover', handleDragOver);
      window.removeEventListener('dragleave', handleDragLeave);
      window.removeEventListener('drop', handleDrop);
    };
  }, [enabled, importDroppedFiles, updateDropTarget]);

  // 2. Native Tauri v2 OS Drag-and-Drop listener (Desktop WebView2 / WKWebView / WebKitGTK)
  useEffect(() => {
    if (!enabled || typeof window === 'undefined') return;
    if (!(window as TauriWindow).__TAURI_INTERNALS__) return;

    let cancelled = false;
    let unlisten: (() => void) | null = null;

    const toLogicalPoint = (pos: { x: number; y: number }) => {
      const dpr = window.devicePixelRatio || 1;
      return { x: pos.x / dpr, y: pos.y / dpr };
    };

    void (async () => {
      try {
        const { getCurrentWebview } = await import('@tauri-apps/api/webview');
        if (cancelled) return;
        const stop = await getCurrentWebview().onDragDropEvent((event) => {
          if (cancelled) return;
          const payload = event.payload;
          if (payload.type === 'enter') {
            tauriDragHasImagesRef.current =
              payload.paths.length === 0 || payload.paths.some(isSupportedImageExtension);
            if (!tauriDragHasImagesRef.current) {
              updateDropTarget(null);
              return;
            }
            const pt = toLogicalPoint(payload.position);
            updateDropTarget(resolveDropZoneAtPoint(pt.x, pt.y));
          } else if (payload.type === 'over') {
            if (!tauriDragHasImagesRef.current) {
              updateDropTarget(null);
              return;
            }
            const pt = toLogicalPoint(payload.position);
            updateDropTarget(resolveDropZoneAtPoint(pt.x, pt.y));
          } else if (payload.type === 'leave') {
            tauriDragHasImagesRef.current = true;
            updateDropTarget(null);
          } else if (payload.type === 'drop') {
            tauriDragHasImagesRef.current = true;
            const pt = toLogicalPoint(payload.position);
            const resolved =
              resolveDropZoneAtPoint(pt.x, pt.y) ?? activeDropTargetRef.current;
            updateDropTarget(null);
            if (!resolved || payload.paths.length === 0) return;
            void importDroppedPaths(payload.paths, {
              targetLayerId: resolved.targetLayerId,
              position: resolved.position,
            });
          }
        });
        if (cancelled) {
          stop();
        } else {
          unlisten = stop;
        }
      } catch (err) {
        console.warn('Failed to attach Tauri drag-drop listener:', err);
      }
    })();

    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [enabled, importDroppedPaths, updateDropTarget]);

  return {
    activeDropTarget,
    importDroppedFiles,
  };
}
