import {
  ToolType,
  BrushSettings,
  BrushPresetId,
  CanvasColorMode,
  WandSettings,
  FillSettings,
  TextSettings,
  FrameSettings,
  BalloonSettings,
  VectorEditSettings,
  LiquifySettings,
} from '../types/editor';
import {
  saveBrushSettingsDebounced,
  getEffectiveBrushSettings,
  getActivePresetId,
  saveActivePresetId,
  ERASER_PRESET_ID,
  DEFAULT_BRUSH_PRESET_ID,
} from '../utils/brushPresetManager';
import { enforceColorMode } from '../utils/colorUtils';
import { safeLocalStorageSetItem } from '../utils/safeStorage';
import { createStore } from './createStore';
import { useDocumentStore } from './useDocumentStore';

export interface QuickModifiersState {
  isAltActive: boolean;
  isSpaceDown: boolean;
  isShiftDown: boolean;
  isRotateModifier: boolean;
}

export interface ToolStoreState {
  tool: ToolType;
  activePresetId: BrushPresetId;
  brushSettings: BrushSettings;
  primaryColor: string;
  secondaryColor: string;
  isTransparentColor: boolean;
  recentColors: string[];
  quickModifiers: QuickModifiersState;
  wandSettings: WandSettings;
  fillSettings: FillSettings;
  textSettings: TextSettings;
  frameSettings: FrameSettings;
  balloonSettings: BalloonSettings;
  vectorEditSettings: VectorEditSettings;
  liquifySettings: LiquifySettings;
}

const DEFAULT_RECENT_COLORS = [
  '#000000',
  '#3b82f6',
  '#ef4444',
  '#10b981',
  '#f59e0b',
  '#ffffff',
];

function createInitialBrushSettings(): { presetId: BrushPresetId; brushSettings: BrushSettings } {
  const activePreset = getActivePresetId();
  const effective = getEffectiveBrushSettings(activePreset);
  const resolvedPreset = (effective.preset || activePreset || DEFAULT_BRUSH_PRESET_ID) as BrushPresetId;
  return {
    presetId: resolvedPreset,
    brushSettings: {
      preset: resolvedPreset,
      size: effective.size ?? 8,
      minSizeFactor: effective.minSizeFactor ?? 0.04,
      color: '#000000',
      secondaryColor: '#ffffff',
      opacity: effective.opacity ?? 1.0,
      flow: effective.flow ?? 1.0,
      spacing: effective.spacing ?? 0.04,
      grain: effective.grain ?? 0,
      usePressure: effective.usePressure ?? true,
      smoothing: effective.smoothing ?? true,
      stabilization: effective.stabilization ?? 20,
      hardness: effective.hardness ?? 1.0,
      ...effective,
    } as BrushSettings,
  };
}

function loadInitialLiquifySettings(): LiquifySettings {
  try {
    if (typeof localStorage !== 'undefined') {
      const saved = localStorage.getItem('sora_paint_liquify_settings');
      if (saved) return JSON.parse(saved) as LiquifySettings;
    }
  } catch {
    // Ignore storage errors
  }
  return {
    mode: 'push',
    size: 80,
    strength: 50,
    hardness: 50,
    usePressure: true,
  };
}

const createInitialToolState = (): ToolStoreState => {
  const { presetId, brushSettings } = createInitialBrushSettings();
  return {
    tool: 'brush',
    activePresetId: presetId,
    brushSettings,
    primaryColor: '#000000',
    secondaryColor: '#ffffff',
    isTransparentColor: false,
    recentColors: [...DEFAULT_RECENT_COLORS],
    quickModifiers: {
      isAltActive: false,
      isSpaceDown: false,
      isShiftDown: false,
      isRotateModifier: false,
    },
    wandSettings: {
      tolerance: 32,
      contiguous: true,
      antiAlias: true,
      referMode: 'active',
    },
    fillSettings: {
      method: 'refer-all',
      tolerance: 32,
    },
    textSettings: {
      text: '',
      fontFamily: "'Neucha', 'Anime Ace', 'Comic Sans MS', sans-serif",
      fontSize: 28,
      lineSpacing: 1.25,
      bold: false,
      italic: false,
      align: 'center',
      outline: true,
      outlineColor: '#ffffff',
      outlineWidth: 3,
      color: '#000000',
    },
    frameSettings: {
      mode: 'create',
      divideMode: 'same-folder',
      thickness: 4,
      fillBackground: true,
      fillColor: '#ffffff',
      strokeColor: '#000000',
      gutterVerticalMm: 3.0,
      gutterHorizontalMm: 5.0,
    },
    balloonSettings: {
      shape: 'ellipse',
      fillColor: '#ffffff',
      strokeColor: '#000000',
      strokeWidth: 3,
      text: '',
      fontFamily: "'Neucha', 'Anime Ace', 'Comic Sans MS', sans-serif",
      fontSize: 22,
      vertical: false,
    },
    vectorEditSettings: {
      mode: 'pinch',
      radius: 35,
      pinchStrength: 1.0,
      widthFactor: 1.5,
      simplifyTolerance: 2.0,
    },
    liquifySettings: loadInitialLiquifySettings(),
  };
};

export const useToolStore = createStore<ToolStoreState>(createInitialToolState);

export const toolStoreActions = {
  selectTool(newTool: ToolType): void {
    const state = useToolStore.getState();
    const prevTool = state.tool;
    if (prevTool === newTool) return;

    if (newTool === 'eraser') {
      const eraserSettings = getEffectiveBrushSettings(ERASER_PRESET_ID);
      useToolStore.setState({
        tool: newTool,
        brushSettings: {
          ...state.brushSettings,
          ...eraserSettings,
          color: state.brushSettings.color,
        },
      });
      return;
    }

    if (prevTool === 'eraser' && newTool === 'brush') {
      const activePreset = state.brushSettings.preset || getActivePresetId();
      const brushCfg = getEffectiveBrushSettings(activePreset);
      useToolStore.setState({
        tool: newTool,
        activePresetId: activePreset,
        brushSettings: {
          ...state.brushSettings,
          ...brushCfg,
          color: state.brushSettings.color,
        },
      });
      return;
    }

    useToolStore.setState({ tool: newTool });
  },

  setToolRaw(tool: ToolType): void {
    useToolStore.setState({ tool });
  },

  updateBrushSettings(newSettings: Partial<BrushSettings>): void {
    const state = useToolStore.getState();
    const next: BrushSettings = { ...state.brushSettings, ...newSettings };
    const targetPresetId =
      state.tool === 'eraser'
        ? ERASER_PRESET_ID
        : next.preset || state.brushSettings.preset || DEFAULT_BRUSH_PRESET_ID;

    saveBrushSettingsDebounced(targetPresetId, next);
    if (next.preset && state.tool === 'brush') {
      saveActivePresetId(next.preset);
    }

    useToolStore.setState({
      brushSettings: next,
      activePresetId:
        next.preset && state.tool === 'brush' ? next.preset : state.activePresetId,
    });
  },

  addRecentColor(color: string): void {
    useToolStore.setState((prev) => {
      const filtered = prev.recentColors.filter(
        (c) => c.toLowerCase() !== color.toLowerCase()
      );
      return { recentColors: [color, ...filtered].slice(0, 14) };
    });
  },

  setPrimaryColor(color: string, commit = true, colorModeOverride?: CanvasColorMode): void {
    const mode = colorModeOverride ?? useDocumentStore.getState().colorMode;
    const effective = enforceColorMode(color, mode);
    const state = useToolStore.getState();

    const nextBrush: BrushSettings = {
      ...state.brushSettings,
      color: effective,
      isTransparentInk: false,
    };
    const targetPresetId =
      state.tool === 'eraser'
        ? ERASER_PRESET_ID
        : nextBrush.preset || DEFAULT_BRUSH_PRESET_ID;
    saveBrushSettingsDebounced(targetPresetId, nextBrush);

    const nextRecent = commit
      ? [
          effective,
          ...state.recentColors.filter((c) => c.toLowerCase() !== effective.toLowerCase()),
        ].slice(0, 14)
      : state.recentColors;

    useToolStore.setState({
      primaryColor: effective,
      isTransparentColor: false,
      brushSettings: nextBrush,
      recentColors: nextRecent,
    });

    if (state.tool === 'eraser') {
      toolStoreActions.selectTool('brush');
    }
  },

  setSecondaryColor(color: string, commit = true, colorModeOverride?: CanvasColorMode): void {
    const mode = colorModeOverride ?? useDocumentStore.getState().colorMode;
    const effective = enforceColorMode(color, mode);
    const state = useToolStore.getState();

    const nextBrush: BrushSettings = {
      ...state.brushSettings,
      secondaryColor: effective,
    };
    const targetPresetId =
      state.tool === 'eraser'
        ? ERASER_PRESET_ID
        : nextBrush.preset || DEFAULT_BRUSH_PRESET_ID;
    saveBrushSettingsDebounced(targetPresetId, nextBrush);

    const nextRecent = commit
      ? [
          effective,
          ...state.recentColors.filter((c) => c.toLowerCase() !== effective.toLowerCase()),
        ].slice(0, 14)
      : state.recentColors;

    useToolStore.setState({
      secondaryColor: effective,
      brushSettings: nextBrush,
      recentColors: nextRecent,
    });
  },

  swapColors(colorModeOverride?: CanvasColorMode): void {
    const mode = colorModeOverride ?? useDocumentStore.getState().colorMode;
    const state = useToolStore.getState();
    const prevPrimary = state.primaryColor;
    const effectivePrimary = enforceColorMode(state.secondaryColor, mode);
    const nextBrush: BrushSettings = {
      ...state.brushSettings,
      color: effectivePrimary,
      secondaryColor: prevPrimary,
      isTransparentInk: false,
    };
    const targetPresetId =
      state.tool === 'eraser'
        ? ERASER_PRESET_ID
        : nextBrush.preset || DEFAULT_BRUSH_PRESET_ID;
    saveBrushSettingsDebounced(targetPresetId, nextBrush);

    const nextRecent = [
      effectivePrimary,
      ...state.recentColors.filter(
        (c) => c.toLowerCase() !== effectivePrimary.toLowerCase()
      ),
    ].slice(0, 14);

    useToolStore.setState({
      primaryColor: effectivePrimary,
      secondaryColor: prevPrimary,
      isTransparentColor: false,
      brushSettings: nextBrush,
      recentColors: nextRecent,
    });

    if (state.tool === 'eraser') {
      toolStoreActions.selectTool('brush');
    }
  },

  toggleTransparentColor(): boolean {
    const state = useToolStore.getState();
    const next = !state.isTransparentColor;
    const nextBrush: BrushSettings = {
      ...state.brushSettings,
      isTransparentInk: next,
    };
    const targetPresetId =
      state.tool === 'eraser'
        ? ERASER_PRESET_ID
        : nextBrush.preset || DEFAULT_BRUSH_PRESET_ID;
    saveBrushSettingsDebounced(targetPresetId, nextBrush);

    useToolStore.setState({
      isTransparentColor: next,
      brushSettings: nextBrush,
    });
    return next;
  },

  resetDefaultColors(colorModeOverride?: CanvasColorMode): void {
    toolStoreActions.setPrimaryColor('#000000', true, colorModeOverride);
    toolStoreActions.setSecondaryColor('#ffffff', false, colorModeOverride);
  },

  setQuickModifiers(patch: Partial<QuickModifiersState>): void {
    useToolStore.setState((prev) => ({
      quickModifiers: { ...prev.quickModifiers, ...patch },
    }));
  },

  updateWandSettings(patch: Partial<WandSettings>): void {
    useToolStore.setState((prev) => ({
      wandSettings: { ...prev.wandSettings, ...patch },
    }));
  },

  updateFillSettings(patch: Partial<FillSettings>): void {
    useToolStore.setState((prev) => ({
      fillSettings: { ...prev.fillSettings, ...patch },
    }));
  },

  updateTextSettings(patch: Partial<TextSettings>): void {
    useToolStore.setState((prev) => ({
      textSettings: { ...prev.textSettings, ...patch },
    }));
  },

  updateFrameSettings(patch: Partial<FrameSettings>): void {
    useToolStore.setState((prev) => ({
      frameSettings: { ...prev.frameSettings, ...patch },
    }));
  },

  updateBalloonSettings(patch: Partial<BalloonSettings>): void {
    useToolStore.setState((prev) => ({
      balloonSettings: { ...prev.balloonSettings, ...patch },
    }));
  },

  updateVectorEditSettings(patch: Partial<VectorEditSettings>): void {
    useToolStore.setState((prev) => ({
      vectorEditSettings: { ...prev.vectorEditSettings, ...patch },
    }));
  },

  updateLiquifySettings(patch: Partial<LiquifySettings>): void {
    useToolStore.setState((prev) => {
      const next = { ...prev.liquifySettings, ...patch };
      safeLocalStorageSetItem('sora_paint_liquify_settings', JSON.stringify(next), 'liquify settings');
      return { liquifySettings: next };
    });
  },
};
