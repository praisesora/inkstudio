import React, { useEffect, useRef } from 'react';
import {
  AnimationTimeline,
  CanvasDimensions,
  CanvasSelection,
  LayerItem,
  ToolType,
  TransformSession,
} from '../types/editor';
import { createDefaultAnimationTimeline } from '../utils/animationEngine';
import { createDefaultPerspectiveRuler } from '../utils/perspectiveMath';
import {
  flushPendingBrushSettingsSave,
  stepBrushSizePreset,
} from '../utils/brushPresetManager';
import { parseSutFile } from '../utils/sutParser';
import {
  deleteCustomBrush,
  loadCustomBrushes,
  prepareBrushSettingsForCsp,
  saveCustomBrush,
} from '../utils/brushStorage';
import { TonalCorrectionType } from '../utils/tonalEngine';
import {
  documentStoreActions,
  selectIsAnyModalOpen,
  toolStoreActions,
  uiStoreActions,
  useToolStore,
  useUiStore,
  workspaceStoreActions,
} from '../stores';
import { TextPlacementSession } from '../hooks/drawing/useShapeAndFillTools';

export interface GlobalShortcutListenerProps {
  hasOpenDocument: boolean;
  dimensions: CanvasDimensions;
  layers: LayerItem[];
  activeLayer: LayerItem | undefined;
  activeLayerId: string;
  selection: CanvasSelection | null;
  transformSession: TransformSession | null;
  textSession: TextPlacementSession | null;
  activeAnimationTimeline: AnimationTimeline | null;
  isSpaceDown: boolean;
  isHostModalOpen: boolean;
  isDrawingRef: React.MutableRefObject<boolean>;
  isSelectionPenDrawingRef: React.MutableRefObject<boolean>;
  isPipetteSamplingRef: React.MutableRefObject<boolean>;
  handleUndo: () => void;
  redo: () => void;
  handleAddLayer: (type?: 'raster' | 'folder') => void;
  handleTriggerOpenFile: () => void;
  handleSave: () => void;
  handleSaveAs: () => void;
  duplicateLayer: (layerId: string) => void;
  handleCopySelectedLayer: () => void;
  handlePasteSelectedLayer: () => void;
  handleGroupSelectedLayers: () => void;
  handleStartTransform: () => void;
  handleSelectAll: () => void;
  handleDeselect: () => void;
  handleInvertSelection: () => void;
  handleApplyReverseGradient: () => void;
  handleOpenTonalModal: (type: TonalCorrectionType) => void;
  handleUpdateAnimationTimeline: (timeline: AnimationTimeline | null) => void;
  handleAddAnimationCel: (frameIndex: number) => void;
  toggleFlipHorizontal: () => void;
  toggleFlipVertical: () => void;
  handleClearSelection: () => void;
  handleDeleteSelectedLayer: () => void;
  handleCancelTransform: () => void;
  handleCancelText: () => void;
  handleApplyTransform: () => void;
  handleProcessFile: (file: File) => void;
  showToast: (msg: string) => void;
}

const CODE_TO_TOOL: Record<string, ToolType> = {
  KeyB: 'brush',
  KeyE: 'eraser',
  KeyI: 'pipette',
  KeyJ: 'liquify',
  KeyM: 'select-rect',
  KeyL: 'select-lasso',
  KeyW: 'select-wand',
  KeyG: 'fill',
  KeyT: 'text',
  KeyF: 'frame',
  KeyO: 'balloon',
  KeyY: 'vector-edit',
};

function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target.isContentEditable;
}

/**
 * Headless listener for global hotkeys, temporary tool holds, Alt eyedropper hold,
 * drag-and-drop file import, and beforeunload brush settings persistence.
 * Reads tool/UI/document stores imperatively to avoid re-renders on brush/color edits.
 */
export const GlobalShortcutListener: React.FC<GlobalShortcutListenerProps> = React.memo(
  (props) => {
    const propsRef = useRef(props);
    propsRef.current = props;

    const previousToolBeforeAltRef = useRef<ToolType | null>(null);
    const isAltActiveRef = useRef<boolean>(false);
    const tempToolHoldRef = useRef<{
      code: string;
      prevTool: ToolType;
      targetTool: ToolType;
      downAt: number;
      usedWhileHeld: boolean;
    } | null>(null);

    // Flush debounced brush settings on window close/unmount
    useEffect(() => {
      const handleBeforeUnload = () => flushPendingBrushSettingsSave();
      window.addEventListener('beforeunload', handleBeforeUnload);
      return () => {
        flushPendingBrushSettingsSave();
        window.removeEventListener('beforeunload', handleBeforeUnload);
      };
    }, []);

    // Global Keyboard Shortcuts (Layout-Independent e.code + CSP Hold-and-Release Temporary Tools)
    useEffect(() => {
      const handleKeyDown = (e: KeyboardEvent) => {
        const p = propsRef.current;
        const uiState = useUiStore.getState();
        const isModalOpen = selectIsAnyModalOpen(uiState, p.isHostModalOpen) || uiState.isLoadingFile;
        if (isModalOpen || isEditableTarget(e.target)) {
          return;
        }

        const key = e.key.toLowerCase();
        const code = e.code;

        // Ctrl / Cmd shortcuts
        if (e.ctrlKey || e.metaKey) {
          if (e.altKey && !e.shiftKey && (code === 'KeyA' || key === 'a')) {
            if (!p.hasOpenDocument) return;
            e.preventDefault();
            if (p.activeAnimationTimeline) {
              p.handleUpdateAnimationTimeline(null);
            } else {
              p.handleUpdateAnimationTimeline(createDefaultAnimationTimeline(p.layers));
            }
            return;
          }

          if (e.altKey && !e.shiftKey && (code === 'KeyY' || key === 'y')) {
            if (!p.hasOpenDocument) return;
            e.preventDefault();
            documentStoreActions.toggleSoftProof();
            return;
          }

          if (e.altKey) return;

          if (!e.shiftKey && (code === 'KeyZ' || key === 'z')) {
            if (!p.hasOpenDocument) return;
            e.preventDefault();
            p.handleUndo();
            return;
          }

          if (
            (e.shiftKey && (code === 'KeyZ' || key === 'z')) ||
            (!e.shiftKey && (code === 'KeyY' || key === 'y'))
          ) {
            if (!p.hasOpenDocument) return;
            e.preventDefault();
            p.redo();
            return;
          }

          if (e.shiftKey && (code === 'KeyY' || key === 'y')) {
            if (!p.hasOpenDocument) return;
            e.preventDefault();
            documentStoreActions.toggleGamutWarning();
            return;
          }

          if (e.shiftKey && (code === 'KeyN' || key === 'n')) {
            if (!p.hasOpenDocument) return;
            e.preventDefault();
            p.handleAddLayer('raster');
            return;
          }

          if (!e.shiftKey && (code === 'KeyN' || key === 'n')) {
            e.preventDefault();
            uiStoreActions.setNewCanvasModalOpen(true);
            return;
          }

          if (!e.shiftKey && (code === 'KeyO' || key === 'o')) {
            e.preventDefault();
            p.handleTriggerOpenFile();
            return;
          }

          if (e.shiftKey && (code === 'KeyS' || key === 's')) {
            if (!p.hasOpenDocument) return;
            e.preventDefault();
            p.handleSaveAs();
            return;
          }

          if (!e.shiftKey && (code === 'KeyS' || key === 's')) {
            if (!p.hasOpenDocument) return;
            e.preventDefault();
            p.handleSave();
            return;
          }

          if (!e.shiftKey && (code === 'KeyJ' || key === 'j')) {
            if (!p.hasOpenDocument || !p.activeLayer) return;
            e.preventDefault();
            p.duplicateLayer(p.activeLayerId);
            return;
          }

          if (!e.shiftKey && (code === 'KeyC' || key === 'c')) {
            if (!p.hasOpenDocument) return;
            const textSel = window.getSelection()?.toString();
            if (!textSel || textSel.length === 0) {
              e.preventDefault();
              p.handleCopySelectedLayer();
              return;
            }
          }

          if (!e.shiftKey && (code === 'KeyV' || key === 'v')) {
            if (!p.hasOpenDocument) return;
            e.preventDefault();
            p.handlePasteSelectedLayer();
            return;
          }

          if (!e.shiftKey && (code === 'KeyG' || key === 'g')) {
            if (!p.hasOpenDocument) return;
            e.preventDefault();
            p.handleGroupSelectedLayers();
            return;
          }

          if (!e.shiftKey && (code === 'KeyT' || key === 't')) {
            if (!p.hasOpenDocument) return;
            e.preventDefault();
            p.handleStartTransform();
            return;
          }

          if (!e.shiftKey && (code === 'KeyA' || key === 'a')) {
            if (!p.hasOpenDocument) return;
            e.preventDefault();
            p.handleSelectAll();
            return;
          }

          if (!e.shiftKey && (code === 'KeyD' || key === 'd')) {
            if (!p.hasOpenDocument) return;
            e.preventDefault();
            p.handleDeselect();
            return;
          }

          if (e.shiftKey && (code === 'KeyI' || key === 'i')) {
            if (!p.hasOpenDocument) return;
            e.preventDefault();
            p.handleInvertSelection();
            return;
          }

          if (!e.shiftKey && (code === 'KeyI' || key === 'i')) {
            if (
              !p.hasOpenDocument ||
              !p.activeLayer ||
              p.activeLayer.locked ||
              p.activeLayer.type !== 'raster'
            ) {
              return;
            }
            e.preventDefault();
            p.handleApplyReverseGradient();
            return;
          }

          if (!e.shiftKey && (code === 'KeyU' || key === 'u')) {
            if (
              !p.hasOpenDocument ||
              !p.activeLayer ||
              p.activeLayer.locked ||
              p.activeLayer.type !== 'raster'
            ) {
              return;
            }
            e.preventDefault();
            p.handleOpenTonalModal('hue-saturation');
            return;
          }

          if (!e.shiftKey && (code === 'Comma' || key === ',' || key === '<')) {
            e.preventDefault();
            uiStoreActions.setSettingsModalOpen(true);
            return;
          }

          if (e.shiftKey && (code === 'KeyR' || key === 'r')) {
            e.preventDefault();
            documentStoreActions.setPerspectiveRuler((prev) => {
              if (!prev) {
                const next = createDefaultPerspectiveRuler('2-point', p.dimensions);
                p.showToast('2-Point Perspective Ruler added to canvas');
                return next;
              }
              const next = { ...prev, enabled: !prev.enabled };
              p.showToast(next.enabled ? 'Perspective Ruler: Shown' : 'Perspective Ruler: Hidden');
              return next;
            });
            return;
          }

          if (e.shiftKey && (code === 'KeyP' || key === 'p')) {
            e.preventDefault();
            documentStoreActions.setPerspectiveRuler((prev) => {
              if (!prev) return null;
              const next = { ...prev, snapEnabled: !prev.snapEnabled };
              p.showToast(
                next.snapEnabled ? 'Perspective Snapping: ON' : 'Perspective Snapping: OFF'
              );
              return next;
            });
            return;
          }
          return;
        }

        // Alt-only shortcuts: Alt+C -> Add Animation Cel
        if (e.altKey && !e.ctrlKey && !e.metaKey) {
          if (!e.shiftKey && (code === 'KeyC' || key === 'c')) {
            if (!p.hasOpenDocument || !p.activeAnimationTimeline) return;
            e.preventDefault();
            if (isAltActiveRef.current && previousToolBeforeAltRef.current !== null) {
              toolStoreActions.setToolRaw(previousToolBeforeAltRef.current);
              previousToolBeforeAltRef.current = null;
              isAltActiveRef.current = false;
              toolStoreActions.setQuickModifiers({ isAltActive: false });
            }
            p.handleAddAnimationCel(p.activeAnimationTimeline.currentFrame);
          }
          return;
        }

        // Tab / Shift+Tab: Toggle UI Panels (CSP Hide/Show Palettes)
        if (code === 'Tab' && !p.textSession) {
          e.preventDefault();
          if (e.shiftKey) {
            uiStoreActions.toggleLeftPanelHidden();
          } else {
            workspaceStoreActions.togglePalettesHidden();
          }
          return;
        }

        // Brush Size Stepper: [ and ]
        if (!e.shiftKey && (code === 'BracketLeft' || code === 'BracketRight')) {
          e.preventDefault();
          const dir: -1 | 1 = code === 'BracketLeft' ? -1 : 1;
          const toolState = useToolStore.getState();
          if (toolState.tool === 'liquify') {
            const nextSize = Math.max(
              4,
              Math.min(500, Math.round(stepBrushSizePreset(toolState.liquifySettings.size, dir)))
            );
            toolStoreActions.updateLiquifySettings({ size: nextSize });
          } else {
            const nextSize = stepBrushSizePreset(toolState.brushSettings.size, dir);
            toolStoreActions.updateBrushSettings({ size: nextSize });
          }
          return;
        }

        // Non-destructive View Flip shortcuts
        if (e.shiftKey && !p.isSpaceDown) {
          if (code === 'KeyH' || key === 'h') {
            if (!p.hasOpenDocument || e.repeat) return;
            e.preventDefault();
            p.toggleFlipHorizontal();
            return;
          }
          if (code === 'KeyV' || key === 'v') {
            if (!p.hasOpenDocument || e.repeat) return;
            e.preventDefault();
            p.toggleFlipVertical();
            return;
          }
        }

        // Single-key tool & color shortcuts
        if (!e.shiftKey) {
          const mappedTool = CODE_TO_TOOL[code];
          if (mappedTool) {
            if (e.repeat) return;
            const prev = useToolStore.getState().tool;
            if (prev !== mappedTool) {
              tempToolHoldRef.current = {
                code,
                prevTool: prev,
                targetTool: mappedTool,
                downAt: performance.now(),
                usedWhileHeld: false,
              };
              toolStoreActions.selectTool(mappedTool);
            }
            return;
          }

          if (code === 'KeyX' || key === 'x') {
            if (!e.repeat) toolStoreActions.swapColors();
            return;
          }
          if (code === 'KeyD' || key === 'd') {
            if (!e.repeat) toolStoreActions.resetDefaultColors();
            return;
          }
          if (code === 'KeyC' || key === 'c') {
            if (!e.repeat) {
              const next = toolStoreActions.toggleTransparentColor();
              p.showToast(next ? 'Transparent ink mode active' : 'Color ink mode active');
            }
            return;
          }
        }

        if (key === 'delete' || key === 'backspace') {
          if (!p.hasOpenDocument) return;
          e.preventDefault();
          if (p.selection) {
            p.handleClearSelection();
          } else {
            p.handleDeleteSelectedLayer();
          }
        } else if (key === 'escape') {
          if (p.transformSession?.active) {
            e.preventDefault();
            p.handleCancelTransform();
          } else if (p.textSession) {
            e.preventDefault();
            p.handleCancelText();
          } else if (p.selection) {
            e.preventDefault();
            p.handleDeselect();
          }
        } else if (key === 'enter') {
          if (p.transformSession?.active) {
            e.preventDefault();
            p.handleApplyTransform();
          }
        }
      };

      const handleKeyUp = (e: KeyboardEvent) => {
        const hold = tempToolHoldRef.current;
        if (hold && e.code === hold.code) {
          const heldMs = performance.now() - hold.downAt;
          tempToolHoldRef.current = null;
          if (
            (heldMs >= 220 || hold.usedWhileHeld) &&
            useToolStore.getState().tool === hold.targetTool
          ) {
            toolStoreActions.selectTool(hold.prevTool);
          }
        }
      };

      const handlePointerDownMarkUsed = () => {
        if (tempToolHoldRef.current) {
          tempToolHoldRef.current.usedWhileHeld = true;
        }
      };

      const handleWindowBlur = () => {
        tempToolHoldRef.current = null;
      };

      window.addEventListener('keydown', handleKeyDown);
      window.addEventListener('keyup', handleKeyUp);
      window.addEventListener('pointerdown', handlePointerDownMarkUsed, true);
      window.addEventListener('blur', handleWindowBlur);
      return () => {
        window.removeEventListener('keydown', handleKeyDown);
        window.removeEventListener('keyup', handleKeyUp);
        window.removeEventListener('pointerdown', handlePointerDownMarkUsed, true);
        window.removeEventListener('blur', handleWindowBlur);
      };
    }, []);

    // Alt-hold temporary pipette
    useEffect(() => {
      const handleKeyDown = (e: KeyboardEvent) => {
        const p = propsRef.current;
        const uiState = useUiStore.getState();
        const isModalOpen = selectIsAnyModalOpen(uiState, p.isHostModalOpen) || uiState.isLoadingFile;
        if (isModalOpen || isEditableTarget(e.target)) {
          return;
        }

        if (e.key === 'Alt') {
          if (
            !e.ctrlKey &&
            !e.metaKey &&
            !p.isDrawingRef.current &&
            !p.isSelectionPenDrawingRef.current
          ) {
            e.preventDefault();
            if (!isAltActiveRef.current && !e.repeat) {
              isAltActiveRef.current = true;
              toolStoreActions.setQuickModifiers({ isAltActive: true });
              const currentTool = useToolStore.getState().tool;
              if (currentTool !== 'pipette') {
                previousToolBeforeAltRef.current = currentTool;
                toolStoreActions.setToolRaw('pipette');
              }
            }
          }
          return;
        }

        if ((e.ctrlKey || e.metaKey || e.code === 'Space') && isAltActiveRef.current) {
          if (previousToolBeforeAltRef.current !== null) {
            toolStoreActions.setToolRaw(previousToolBeforeAltRef.current);
            previousToolBeforeAltRef.current = null;
          }
          isAltActiveRef.current = false;
          p.isPipetteSamplingRef.current = false;
          toolStoreActions.setQuickModifiers({ isAltActive: false });
        }
      };

      const handleKeyUp = (e: KeyboardEvent) => {
        const p = propsRef.current;
        if (e.key === 'Alt' || (!e.altKey && isAltActiveRef.current)) {
          if (isAltActiveRef.current) {
            e.preventDefault();
            isAltActiveRef.current = false;
            toolStoreActions.setQuickModifiers({ isAltActive: false });
          }
          p.isPipetteSamplingRef.current = false;
          if (previousToolBeforeAltRef.current !== null) {
            toolStoreActions.setToolRaw(previousToolBeforeAltRef.current);
            previousToolBeforeAltRef.current = null;
          }
        }
      };

      const handleBlur = () => {
        const p = propsRef.current;
        isAltActiveRef.current = false;
        p.isPipetteSamplingRef.current = false;
        toolStoreActions.setQuickModifiers({ isAltActive: false });
        if (previousToolBeforeAltRef.current !== null) {
          toolStoreActions.setToolRaw(previousToolBeforeAltRef.current);
          previousToolBeforeAltRef.current = null;
        }
      };

      window.addEventListener('keydown', handleKeyDown);
      window.addEventListener('keyup', handleKeyUp);
      window.addEventListener('blur', handleBlur);
      return () => {
        window.removeEventListener('keydown', handleKeyDown);
        window.removeEventListener('keyup', handleKeyUp);
        window.removeEventListener('blur', handleBlur);
      };
    }, []);

    // Drag and drop onto application window
    useEffect(() => {
      const handleDragOver = (e: DragEvent) => {
        e.preventDefault();
      };

      const handleDrop = async (e: DragEvent) => {
        e.preventDefault();
        const p = propsRef.current;
        if (e.dataTransfer?.files && e.dataTransfer.files.length > 0) {
          const file = e.dataTransfer.files[0];
          if (file.name.toLowerCase().endsWith('.sut')) {
            try {
              uiStoreActions.setLoading(true, `Importing CSP Brush: ${file.name}...`);
              const buffer = await file.arrayBuffer();
              const parsedBrush = await parseSutFile(buffer, file.name);
              const existing = (await loadCustomBrushes()).filter(
                (b) =>
                  b.name.toLowerCase() === parsedBrush.name.toLowerCase() ||
                  b.id === parsedBrush.id
              );
              for (const old of existing) {
                await deleteCustomBrush(old.id).catch(() => {});
              }
              await saveCustomBrush(parsedBrush);
              toolStoreActions.setToolRaw('brush');
              const fullSettings = await prepareBrushSettingsForCsp(parsedBrush);
              toolStoreActions.updateBrushSettings(fullSettings);
              p.showToast(`Imported CSP brush "${parsedBrush.name}" successfully!`);
            } catch (err: unknown) {
              console.error('Failed to import CSP brush:', err);
              const msg = err instanceof Error ? err.message : 'Failed to import .sut brush.';
              p.showToast(msg);
            } finally {
              uiStoreActions.setLoading(false, '');
            }
            return;
          }
          p.handleProcessFile(file);
        }
      };

      window.addEventListener('dragover', handleDragOver);
      window.addEventListener('drop', handleDrop);
      return () => {
        window.removeEventListener('dragover', handleDragOver);
        window.removeEventListener('drop', handleDrop);
      };
    }, []);

    return null;
  }
);

GlobalShortcutListener.displayName = 'GlobalShortcutListener';
