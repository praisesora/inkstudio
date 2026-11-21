import React, { useEffect, useRef } from 'react';
import {
  AnimationTimeline,
  CanvasDimensions,
  CanvasSelection,
  LayerItem,
  ToolType,
  TransformSession,
} from '../types/editor';
import { ModifierAction } from '../types/settings';
import { createDefaultAnimationTimeline } from '../utils/animationEngine';
import { createDefaultPerspectiveRuler } from '../utils/perspectiveMath';
import {
  flushPendingBrushSettingsSave,
  stepBrushSizePreset,
} from '../utils/brushPresetManager';
import { importBrushFile, isSupportedBrushFileName } from '../utils/inkbBrushFormat';
import { TonalCorrectionType } from '../utils/tonalEngine';
import {
  SPRING_LOADED_HOLD_MS,
  SpringLoadedToolController,
  shortcutManager,
} from '../utils/shortcutManager';
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
  zoomIn?: () => void;
  zoomOut?: () => void;
  resetZoomAndCenter?: () => void;
  resetRotation?: () => void;
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

const NON_REPEATABLE_COMMANDS = new Set<string>([
  'color.swap',
  'color.reset',
  'color.transparent',
  'view.flipHorizontal',
  'view.flipVertical',
  'view.togglePalettes',
  'view.toggleLeftPanel',
  'view.softProof',
  'view.gamutWarning',
  'view.straightRuler',
  'view.perspectiveRuler',
  'view.perspectiveSnap',
  'anim.toggleTimeline',
  'app.preferences',
  'file.new',
  'file.open',
  'file.save',
  'file.saveAs',
]);

const NON_TEXT_INPUT_TYPES = new Set([
  'range',
  'checkbox',
  'radio',
  'color',
  'button',
  'submit',
  'reset',
  'file',
  'image',
]);

function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  const tag = target.tagName;
  if (tag === 'TEXTAREA' || tag === 'SELECT') return true;
  if (tag === 'INPUT') {
    const inputType = ((target as HTMLInputElement).type || 'text').toLowerCase();
    return !NON_TEXT_INPUT_TYPES.has(inputType);
  }
  return false;
}

function modifierActionToTempTool(action: ModifierAction): ToolType | null {
  if (action === 'eyedropper') return 'pipette';
  if (action === 'temp-eraser') return 'eraser';
  return null;
}

/**
 * Headless listener for global hotkeys (via centralized ShortcutManager),
 * spring-loaded temporary tool holds (> 250ms), remappable modifier-key temporary tools,
 * drag-and-drop file import, and beforeunload brush settings persistence.
 */
export const GlobalShortcutListener: React.FC<GlobalShortcutListenerProps> = React.memo(
  (props) => {
    const propsRef = useRef(props);
    propsRef.current = props;

    const springControllerRef = useRef(new SpringLoadedToolController(SPRING_LOADED_HOLD_MS));
    const activeModHoldRef = useRef<{
      modKey: 'Alt' | 'Control' | 'Shift';
      prevTool: ToolType;
      tempTool: ToolType;
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

    // Register centralized command handlers once (reads propsRef imperatively)
    useEffect(() => {
      const restoreActiveModTool = () => {
        const mod = activeModHoldRef.current;
        if (!mod) return;
        activeModHoldRef.current = null;
        propsRef.current.isPipetteSamplingRef.current = false;
        toolStoreActions.setQuickModifiers({ isAltActive: false });
        toolStoreActions.setToolRaw(mod.prevTool);
      };

      const stepBrush = (dir: -1 | 1) => {
        const toolState = useToolStore.getState();
        if (toolState.tool === 'liquify') {
          const nextSize = Math.max(
            4,
            Math.min(500, Math.round(stepBrushSizePreset(toolState.liquifySettings.size, dir)))
          );
          toolStoreActions.updateLiquifySettings({ size: nextSize });
        } else if (toolState.tool === 'shape') {
          const nextWidth = Math.max(
            1,
            Math.min(120, Math.round(stepBrushSizePreset(toolState.shapeSettings.strokeWidth, dir)))
          );
          toolStoreActions.updateShapeSettings({ strokeWidth: nextWidth });
        } else {
          const nextSize = stepBrushSizePreset(toolState.brushSettings.size, dir);
          toolStoreActions.updateBrushSettings({ size: nextSize });
        }
      };

      shortcutManager.registerHandlers({
        // Menu / File / App
        'file.new': () => uiStoreActions.setNewCanvasModalOpen(true),
        'file.open': () => propsRef.current.handleTriggerOpenFile(),
        'file.save': () => {
          if (propsRef.current.hasOpenDocument) propsRef.current.handleSave();
        },
        'file.saveAs': () => {
          if (propsRef.current.hasOpenDocument) propsRef.current.handleSaveAs();
        },
        'app.preferences': () => uiStoreActions.setSettingsModalOpen(true),
        'view.togglePalettes': () => {
          if (!propsRef.current.textSession) workspaceStoreActions.togglePalettesHidden();
        },
        'view.toggleLeftPanel': () => {
          if (!propsRef.current.textSession) uiStoreActions.toggleLeftPanelHidden();
        },
        'view.softProof': () => {
          if (propsRef.current.hasOpenDocument) documentStoreActions.toggleSoftProof();
        },
        'view.gamutWarning': () => {
          if (propsRef.current.hasOpenDocument) documentStoreActions.toggleGamutWarning();
        },
        'anim.toggleTimeline': () => {
          const p = propsRef.current;
          if (!p.hasOpenDocument) return;
          if (p.activeAnimationTimeline) {
            p.handleUpdateAnimationTimeline(null);
          } else {
            p.handleUpdateAnimationTimeline(createDefaultAnimationTimeline(p.layers));
          }
        },
        'anim.addCel': () => {
          const p = propsRef.current;
          if (!p.hasOpenDocument || !p.activeAnimationTimeline) return;
          restoreActiveModTool();
          p.handleAddAnimationCel(p.activeAnimationTimeline.currentFrame);
        },

        // Edit
        'edit.undo': () => {
          if (propsRef.current.hasOpenDocument) propsRef.current.handleUndo();
        },
        'edit.redo': () => {
          const p = propsRef.current;
          if (!p.hasOpenDocument || p.transformSession?.active) return;
          p.redo();
        },
        'edit.copy': () => {
          if (!propsRef.current.hasOpenDocument) return;
          propsRef.current.handleCopySelectedLayer();
        },
        'edit.paste': () => {
          if (propsRef.current.hasOpenDocument) propsRef.current.handlePasteSelectedLayer();
        },
        'edit.delete': () => {
          const p = propsRef.current;
          if (!p.hasOpenDocument) return;
          if (p.selection) p.handleClearSelection();
          else p.handleDeleteSelectedLayer();
        },
        'edit.transform': () => {
          if (propsRef.current.hasOpenDocument) propsRef.current.handleStartTransform();
        },
        'edit.selectAll': () => {
          if (propsRef.current.hasOpenDocument) propsRef.current.handleSelectAll();
        },
        'edit.deselect': () => {
          if (propsRef.current.hasOpenDocument) propsRef.current.handleDeselect();
        },
        'edit.invertSelection': () => {
          if (propsRef.current.hasOpenDocument) propsRef.current.handleInvertSelection();
        },
        'edit.invertColors': () => {
          const p = propsRef.current;
          if (
            !p.hasOpenDocument ||
            !p.activeLayer ||
            p.activeLayer.locked ||
            p.activeLayer.type !== 'raster'
          ) {
            return;
          }
          p.handleApplyReverseGradient();
        },
        'edit.hueSaturation': () => {
          const p = propsRef.current;
          if (
            !p.hasOpenDocument ||
            !p.activeLayer ||
            p.activeLayer.locked ||
            p.activeLayer.type !== 'raster'
          ) {
            return;
          }
          p.handleOpenTonalModal('hue-saturation');
        },

        // Layer
        'layer.newRaster': () => {
          if (propsRef.current.hasOpenDocument) propsRef.current.handleAddLayer('raster');
        },
        'layer.duplicate': () => {
          const p = propsRef.current;
          if (p.hasOpenDocument && p.activeLayer) p.duplicateLayer(p.activeLayerId);
        },
        'layer.group': () => {
          if (propsRef.current.hasOpenDocument) propsRef.current.handleGroupSelectedLayers();
        },

        // Canvas View
        'view.zoomIn': () => propsRef.current.zoomIn?.(),
        'view.zoomOut': () => propsRef.current.zoomOut?.(),
        'view.resetZoom': () => propsRef.current.resetZoomAndCenter?.(),
        'view.resetRotation': () => propsRef.current.resetRotation?.(),
        'view.flipHorizontal': () => {
          const p = propsRef.current;
          if (p.hasOpenDocument && !p.isSpaceDown) p.toggleFlipHorizontal();
        },
        'view.flipVertical': () => {
          const p = propsRef.current;
          if (p.hasOpenDocument && !p.isSpaceDown) p.toggleFlipVertical();
        },
        'view.straightRuler': () => {
          const p = propsRef.current;
          if (!p.hasOpenDocument) return;
          const next = documentStoreActions.toggleStraightRuler();
          p.showToast(next.enabled ? 'Straight Ruler: ON' : 'Straight Ruler: OFF');
        },
        'view.perspectiveRuler': () => {
          const p = propsRef.current;
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
        },
        'view.perspectiveSnap': () => {
          const p = propsRef.current;
          documentStoreActions.setPerspectiveRuler((prev) => {
            if (!prev) return null;
            const next = { ...prev, snapEnabled: !prev.snapEnabled };
            p.showToast(
              next.snapEnabled ? 'Perspective Snapping: ON' : 'Perspective Snapping: OFF'
            );
            return next;
          });
        },

        // Tools & Colors
        'tool.brushSizeDown': () => stepBrush(-1),
        'tool.brushSizeUp': () => stepBrush(1),
        'color.swap': () => toolStoreActions.swapColors(),
        'color.reset': () => toolStoreActions.resetDefaultColors(),
        'color.transparent': () => {
          const next = toolStoreActions.toggleTransparentColor();
          propsRef.current.showToast(
            next ? 'Transparent ink mode active' : 'Color ink mode active'
          );
        },
      });

      return () => {
        shortcutManager.clearHandlers();
      };
    }, []);

    // Global Keyboard Shortcuts via ShortcutManager + Spring-Loaded Tools + Remappable Modifier Holds
    useEffect(() => {
      const clearModHold = () => {
        const mod = activeModHoldRef.current;
        if (!mod) return;
        activeModHoldRef.current = null;
        propsRef.current.isPipetteSamplingRef.current = false;
        toolStoreActions.setQuickModifiers({ isAltActive: false });
        if (useToolStore.getState().tool === mod.tempTool) {
          toolStoreActions.setToolRaw(mod.prevTool);
        }
      };

      const handleKeyDown = (e: KeyboardEvent) => {
        const p = propsRef.current;
        const uiState = useUiStore.getState();
        const isModalOpen = selectIsAnyModalOpen(uiState, p.isHostModalOpen) || uiState.isLoadingFile;
        if (isModalOpen || isEditableTarget(e.target)) {
          return;
        }

        const modSettings = uiState.appSettings.modifierKeys;

        // 1. Bare modifier key temporary tool holds (Alt / Ctrl / Shift remappable to Eyedropper or Temp Eraser)
        if (
          (e.key === 'Alt' || e.key === 'Control' || e.key === 'Shift') &&
          !p.isDrawingRef.current &&
          !p.isSelectionPenDrawingRef.current
        ) {
          const onlyAlt = e.key === 'Alt' && !e.ctrlKey && !e.metaKey && !e.shiftKey;
          const onlyCtrl = e.key === 'Control' && !e.altKey && !e.shiftKey;
          const onlyShift = e.key === 'Shift' && !e.ctrlKey && !e.metaKey && !e.altKey;

          let action: ModifierAction = 'none';
          let modKey: 'Alt' | 'Control' | 'Shift' | null = null;
          if (onlyAlt) {
            action = modSettings.alt;
            modKey = 'Alt';
          } else if (onlyCtrl) {
            action = modSettings.ctrl;
            modKey = 'Control';
          } else if (onlyShift) {
            action = modSettings.shift;
            modKey = 'Shift';
          }

          const tempTool = modifierActionToTempTool(action);
          if (tempTool && modKey) {
            if (modKey === 'Alt') e.preventDefault();
            if (!activeModHoldRef.current && !e.repeat) {
              const currentTool = useToolStore.getState().tool;
              if (currentTool !== tempTool) {
                activeModHoldRef.current = { modKey, prevTool: currentTool, tempTool };
                if (modKey === 'Alt') {
                  toolStoreActions.setQuickModifiers({ isAltActive: true });
                }
                toolStoreActions.setToolRaw(tempTool);
              }
            }
            return;
          }
        }

        // Cancel temporary modifier tool if combined with another modifier/Space (e.g. Ctrl+Alt brush resize)
        if (
          activeModHoldRef.current &&
          (e.code === 'Space' ||
            (activeModHoldRef.current.modKey === 'Alt' && (e.ctrlKey || e.metaKey || e.shiftKey)) ||
            (activeModHoldRef.current.modKey === 'Control' && (e.altKey || e.shiftKey)) ||
            (activeModHoldRef.current.modKey === 'Shift' && (e.ctrlKey || e.metaKey || e.altKey)))
        ) {
          clearModHold();
        }

        // 2. Match against centralized ShortcutManager (live overrides read imperatively!)
        const overrides = uiState.appSettings.shortcuts;
        shortcutManager.setOverrides(overrides);
        const matched = shortcutManager.matchEvent(e, overrides);

        if (matched) {
          // Guard special contextual exceptions before preventDefault
          if (matched.id === 'edit.copy') {
            const textSel = window.getSelection()?.toString();
            if (textSel && textSel.length > 0) return;
          }
          if (
            (matched.id === 'view.togglePalettes' || matched.id === 'view.toggleLeftPanel') &&
            p.textSession
          ) {
            return;
          }
          if (
            (matched.id === 'view.flipHorizontal' || matched.id === 'view.flipVertical') &&
            p.isSpaceDown
          ) {
            return;
          }

          if (matched.springLoaded && matched.toolId) {
            if (e.repeat) return;
            e.preventDefault();
            const currentTool = useToolStore.getState().tool;
            const nextTool = springControllerRef.current.handleToolKeyDown(
              e.code || matched.id,
              matched.toolId,
              currentTool
            );
            if (nextTool) {
              toolStoreActions.selectTool(nextTool);
            }
            return;
          }

          if (e.repeat && NON_REPEATABLE_COMMANDS.has(matched.id)) {
            return;
          }

          clearModHold();
          e.preventDefault();
          shortcutManager.executeCommand(matched.id);
          return;
        }

        // 3. Contextual Escape / Enter fallbacks for active sessions
        const key = e.key.toLowerCase();
        if (key === 'escape') {
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
        // 1. Release spring-loaded tool hold (> 250ms or used while held)
        const restored = springControllerRef.current.handleKeyUp(
          e.code,
          useToolStore.getState().tool
        );
        if (restored) {
          toolStoreActions.selectTool(restored);
        }

        // 2. Release temporary modifier-key tool hold
        const mod = activeModHoldRef.current;
        if (mod) {
          const released =
            (mod.modKey === 'Alt' && (e.key === 'Alt' || !e.altKey)) ||
            (mod.modKey === 'Control' && (e.key === 'Control' || (!e.ctrlKey && !e.metaKey))) ||
            (mod.modKey === 'Shift' && (e.key === 'Shift' || !e.shiftKey));
          if (released) {
            if (mod.modKey === 'Alt') e.preventDefault();
            clearModHold();
          }
        }
      };

      const handlePointerDownMarkUsed = () => {
        springControllerRef.current.markUsedWhileHeld();
      };

      const handleWindowBlur = () => {
        const restored = springControllerRef.current.cancel(useToolStore.getState().tool);
        if (restored) {
          toolStoreActions.selectTool(restored);
        }
        clearModHold();
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
          if (isSupportedBrushFileName(file.name)) {
            try {
              uiStoreActions.setLoading(true, `Importing Brush: ${file.name}...`);
              const parsedBrush = await importBrushFile(file);
              p.showToast(`Imported brush "${parsedBrush.name}"`);
            } catch (err: unknown) {
              console.error('Failed to import brush:', err);
              const msg = err instanceof Error ? err.message : 'Failed to import brush file.';
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
