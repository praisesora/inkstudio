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
  ShapeSettings,
  GradientSettings,
  GradientMeshState,
  RetouchSettings,
  PenToolSettings,
  Point2D,
} from '../types/editor';
import { DEFAULT_SHAPE_SETTINGS } from '../utils/shapeEngine';
import { DEFAULT_GRADIENT_SETTINGS } from '../utils/gradientEngine';
import { DEFAULT_RETOUCH_SETTINGS } from '../utils/retouchEngine';
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
import { uiStoreActions } from './useUiStore';
import { store3DActions } from './use3DStore';

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
  lastBrushSettings: BrushSettings | null;
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
  shapeSettings: ShapeSettings;
  gradientSettings: GradientSettings;
  retouchSettings: RetouchSettings;
  penSettings: PenToolSettings;
  activeGradientMesh: GradientMeshState | null;
  isPickingCloneSource: boolean;
  cloneSourceAnchor: Point2D | null;
  activePenPointCount: number;
  activePenClosed: boolean;
  activePenSelectedAnchor: number | null;
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
  const defaults: LiquifySettings = {
    mode: 'push',
    size: 80,
    strength: 50,
    hardness: 50,
    usePressure: true,
    multiLayer: false,
  };
  try {
    if (typeof localStorage !== 'undefined') {
      const saved = localStorage.getItem('ink_studio_liquify_settings');
      if (saved) return { ...defaults, ...(JSON.parse(saved) as Partial<LiquifySettings>) };
    }
  } catch {
    // Ignore storage errors
  }
  return defaults;
}

function loadInitialShapeSettings(): ShapeSettings {
  try {
    if (typeof localStorage !== 'undefined') {
      const saved = localStorage.getItem('ink_studio_shape_settings');
      if (saved) return { ...DEFAULT_SHAPE_SETTINGS, ...(JSON.parse(saved) as Partial<ShapeSettings>) };
    }
  } catch {
    // Ignore storage errors
  }
  return { ...DEFAULT_SHAPE_SETTINGS };
}

const DEFAULT_PEN_SETTINGS: PenToolSettings = {
  mode: 'draw',
  strokeWidth: 4,
  opacity: 1,
  strokeEnabled: true,
  fillEnabled: false,
  fillColorMode: 'secondary',
  customFillColor: '#ffffff',
  rubberBandPreview: true,
};

function loadInitialGradientSettings(): GradientSettings {
  try {
    if (typeof localStorage !== 'undefined') {
      const saved = localStorage.getItem('ink_studio_gradient_settings');
      if (saved) {
        const parsed = JSON.parse(saved) as Partial<GradientSettings>;
        return {
          ...DEFAULT_GRADIENT_SETTINGS,
          ...parsed,
          stops:
            Array.isArray(parsed.stops) && parsed.stops.length >= 2
              ? parsed.stops
              : DEFAULT_GRADIENT_SETTINGS.stops.map((s) => ({ ...s })),
        };
      }
    }
  } catch {
    // Ignore storage errors
  }
  return {
    ...DEFAULT_GRADIENT_SETTINGS,
    stops: DEFAULT_GRADIENT_SETTINGS.stops.map((s) => ({ ...s })),
  };
}

function loadInitialRetouchSettings(): RetouchSettings {
  try {
    if (typeof localStorage !== 'undefined') {
      const saved = localStorage.getItem('ink_studio_retouch_settings');
      if (saved) return { ...DEFAULT_RETOUCH_SETTINGS, ...(JSON.parse(saved) as Partial<RetouchSettings>) };
    }
  } catch {
    // Ignore storage errors
  }
  return { ...DEFAULT_RETOUCH_SETTINGS };
}

function loadInitialPenSettings(): PenToolSettings {
  try {
    if (typeof localStorage !== 'undefined') {
      const saved = localStorage.getItem('ink_studio_pen_settings');
      if (saved) return { ...DEFAULT_PEN_SETTINGS, ...(JSON.parse(saved) as Partial<PenToolSettings>) };
    }
  } catch {
    // Ignore storage errors
  }
  return { ...DEFAULT_PEN_SETTINGS };
}

const createInitialToolState = (): ToolStoreState => {
  const { presetId, brushSettings } = createInitialBrushSettings();
  return {
    tool: 'brush',
    activePresetId: presetId,
    brushSettings,
    lastBrushSettings: brushSettings,
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
    shapeSettings: loadInitialShapeSettings(),
    gradientSettings: loadInitialGradientSettings(),
    retouchSettings: loadInitialRetouchSettings(),
    penSettings: loadInitialPenSettings(),
    activeGradientMesh: null,
    isPickingCloneSource: false,
    cloneSourceAnchor: null,
    activePenPointCount: 0,
    activePenClosed: false,
    activePenSelectedAnchor: null,
  };
};

export const useToolStore = createStore<ToolStoreState>(createInitialToolState);

function isValidBrushPresetId(presetId?: string | null): presetId is BrushPresetId {
  return Boolean(presetId && presetId !== ERASER_PRESET_ID && presetId !== 'eraser');
}

function resolveBrushPresetId(state: ToolStoreState): BrushPresetId {
  if (isValidBrushPresetId(state.activePresetId)) {
    return state.activePresetId;
  }
  if (isValidBrushPresetId(state.brushSettings.preset)) {
    return state.brushSettings.preset;
  }
  if (isValidBrushPresetId(state.lastBrushSettings?.preset)) {
    return state.lastBrushSettings.preset;
  }
  return getActivePresetId();
}

function buildRestoredBrushSettings(
  state: ToolStoreState,
  presetId: BrushPresetId
): BrushSettings {
  const effective = getEffectiveBrushSettings(presetId);
  const snapshot =
    state.lastBrushSettings && state.lastBrushSettings.preset === presetId
      ? state.lastBrushSettings
      : null;

  // If getEffectiveBrushSettings couldn't resolve a custom brush from storage/cache
  // and fell back to the default preset, restore the in-memory snapshot instead.
  if (snapshot && effective.preset !== presetId) {
    return {
      ...snapshot,
      preset: presetId,
      color: state.primaryColor,
      secondaryColor: state.secondaryColor,
      isTransparentInk: state.isTransparentColor,
    };
  }

  return {
    ...state.brushSettings,
    ...effective,
    preset: (effective.preset || presetId) as BrushPresetId,
    customTipImage: effective.customTipImage ?? snapshot?.customTipImage,
    dualTipImage: effective.dualTipImage ?? snapshot?.dualTipImage,
    paperTextureImage: effective.paperTextureImage ?? snapshot?.paperTextureImage,
    subTipImages: effective.subTipImages ?? snapshot?.subTipImages,
    color: state.primaryColor,
    secondaryColor: state.secondaryColor,
    isTransparentInk: state.isTransparentColor,
  };
}

export const toolStoreActions = {
  selectTool(newTool: ToolType): void {
    const state = useToolStore.getState();
    const prevTool = state.tool;
    if (newTool === '3d') {
      if (prevTool !== '3d') {
        store3DActions.setPreviousToolBefore3D(prevTool);
      }
      store3DActions.setReferenceVisible(true);
      if (useDocumentStore.getState().documents.length > 0) {
        uiStoreActions.set3DLayerOpen(true);
      }
    }
    if (prevTool === newTool) return;

    if (newTool === 'eraser') {
      const preservedPresetId = resolveBrushPresetId(state);
      const preservedBrushSettings = isValidBrushPresetId(state.brushSettings.preset)
        ? state.brushSettings
        : state.lastBrushSettings;
      const eraserSettings = getEffectiveBrushSettings(ERASER_PRESET_ID);
      useToolStore.setState({
        tool: newTool,
        activePresetId: preservedPresetId,
        lastBrushSettings: preservedBrushSettings,
        brushSettings: {
          ...state.brushSettings,
          ...eraserSettings,
          preset: ERASER_PRESET_ID,
          color: state.primaryColor,
          secondaryColor: state.secondaryColor,
          isTransparentInk: state.isTransparentColor,
        },
      });
      return;
    }

    const activePreset = resolveBrushPresetId(state);
    const needsBrushRestore =
      prevTool === 'eraser' ||
      state.brushSettings.preset === ERASER_PRESET_ID ||
      state.brushSettings.preset === 'eraser' ||
      (newTool === 'brush' && state.brushSettings.preset !== activePreset);

    if (needsBrushRestore) {
      const restoredBrush = buildRestoredBrushSettings(state, activePreset);
      useToolStore.setState({
        tool: newTool,
        activePresetId: (restoredBrush.preset || activePreset) as BrushPresetId,
        brushSettings: restoredBrush,
        lastBrushSettings: restoredBrush,
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
    const isEraser = state.tool === 'eraser';
    const next: BrushSettings = { ...state.brushSettings, ...newSettings };
    const nextValidPreset = isValidBrushPresetId(next.preset) ? next.preset : null;
    const targetPresetId = isEraser
      ? ERASER_PRESET_ID
      : nextValidPreset || resolveBrushPresetId(state);

    saveBrushSettingsDebounced(targetPresetId, next);
    if (!isEraser && nextValidPreset && state.tool === 'brush') {
      saveActivePresetId(nextValidPreset);
    }

    useToolStore.setState({
      brushSettings: next,
      activePresetId:
        !isEraser && nextValidPreset && state.tool === 'brush'
          ? nextValidPreset
          : state.activePresetId,
      lastBrushSettings:
        !isEraser && nextValidPreset ? next : state.lastBrushSettings,
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
    const isEraser = state.tool === 'eraser';

    const nextBrush: BrushSettings = {
      ...state.brushSettings,
      color: effective,
      isTransparentInk: false,
    };
    const targetPresetId = isEraser
      ? ERASER_PRESET_ID
      : isValidBrushPresetId(nextBrush.preset)
        ? nextBrush.preset
        : resolveBrushPresetId(state);
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
      lastBrushSettings:
        !isEraser && isValidBrushPresetId(nextBrush.preset)
          ? nextBrush
          : state.lastBrushSettings,
      recentColors: nextRecent,
    });

    if (isEraser) {
      toolStoreActions.selectTool('brush');
    }
  },

  setSecondaryColor(color: string, commit = true, colorModeOverride?: CanvasColorMode): void {
    const mode = colorModeOverride ?? useDocumentStore.getState().colorMode;
    const effective = enforceColorMode(color, mode);
    const state = useToolStore.getState();
    const isEraser = state.tool === 'eraser';

    const nextBrush: BrushSettings = {
      ...state.brushSettings,
      secondaryColor: effective,
    };
    const targetPresetId = isEraser
      ? ERASER_PRESET_ID
      : isValidBrushPresetId(nextBrush.preset)
        ? nextBrush.preset
        : resolveBrushPresetId(state);
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
      lastBrushSettings:
        !isEraser && isValidBrushPresetId(nextBrush.preset)
          ? nextBrush
          : state.lastBrushSettings,
      recentColors: nextRecent,
    });
  },

  swapColors(colorModeOverride?: CanvasColorMode): void {
    const mode = colorModeOverride ?? useDocumentStore.getState().colorMode;
    const state = useToolStore.getState();
    const isEraser = state.tool === 'eraser';
    const prevPrimary = state.primaryColor;
    const effectivePrimary = enforceColorMode(state.secondaryColor, mode);
    const nextBrush: BrushSettings = {
      ...state.brushSettings,
      color: effectivePrimary,
      secondaryColor: prevPrimary,
      isTransparentInk: false,
    };
    const targetPresetId = isEraser
      ? ERASER_PRESET_ID
      : isValidBrushPresetId(nextBrush.preset)
        ? nextBrush.preset
        : resolveBrushPresetId(state);
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
      lastBrushSettings:
        !isEraser && isValidBrushPresetId(nextBrush.preset)
          ? nextBrush
          : state.lastBrushSettings,
      recentColors: nextRecent,
    });

    if (isEraser) {
      toolStoreActions.selectTool('brush');
    }
  },

  toggleTransparentColor(): boolean {
    const state = useToolStore.getState();
    const isEraser = state.tool === 'eraser';
    const next = !state.isTransparentColor;
    const nextBrush: BrushSettings = {
      ...state.brushSettings,
      isTransparentInk: next,
    };
    const targetPresetId = isEraser
      ? ERASER_PRESET_ID
      : isValidBrushPresetId(nextBrush.preset)
        ? nextBrush.preset
        : resolveBrushPresetId(state);
    saveBrushSettingsDebounced(targetPresetId, nextBrush);

    useToolStore.setState({
      isTransparentColor: next,
      brushSettings: nextBrush,
      lastBrushSettings:
        !isEraser && isValidBrushPresetId(nextBrush.preset)
          ? nextBrush
          : state.lastBrushSettings,
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
      safeLocalStorageSetItem('ink_studio_liquify_settings', JSON.stringify(next), 'liquify settings');
      return { liquifySettings: next };
    });
  },

  updateShapeSettings(patch: Partial<ShapeSettings>): void {
    useToolStore.setState((prev) => {
      const next = { ...prev.shapeSettings, ...patch };
      safeLocalStorageSetItem('ink_studio_shape_settings', JSON.stringify(next), 'shape settings');
      return { shapeSettings: next };
    });
  },

  updateGradientSettings(patch: Partial<GradientSettings>): void {
    useToolStore.setState((prev) => {
      const next = { ...prev.gradientSettings, ...patch };
      safeLocalStorageSetItem('ink_studio_gradient_settings', JSON.stringify(next), 'gradient settings');
      return { gradientSettings: next };
    });
  },

  updateRetouchSettings(patch: Partial<RetouchSettings>): void {
    useToolStore.setState((prev) => {
      const next = { ...prev.retouchSettings, ...patch };
      safeLocalStorageSetItem('ink_studio_retouch_settings', JSON.stringify(next), 'retouch settings');
      return { retouchSettings: next };
    });
  },

  updatePenSettings(patch: Partial<PenToolSettings>): void {
    useToolStore.setState((prev) => {
      const next = { ...prev.penSettings, ...patch };
      safeLocalStorageSetItem('ink_studio_pen_settings', JSON.stringify(next), 'pen settings');
      return { penSettings: next };
    });
  },

  setActiveGradientMesh(
    updater:
      | GradientMeshState
      | null
      | ((prev: GradientMeshState | null) => GradientMeshState | null)
  ): void {
    useToolStore.setState((prev) => ({
      activeGradientMesh:
        typeof updater === 'function' ? updater(prev.activeGradientMesh) : updater,
    }));
  },

  updateActiveGradientMeshNode(index: number, patch: { color?: string; opacity?: number }): void {
    useToolStore.setState((prev) => {
      const mesh = prev.activeGradientMesh;
      if (!mesh || index < 0 || index >= mesh.nodes.length) return prev;
      return {
        activeGradientMesh: {
          ...mesh,
          nodes: mesh.nodes.map((n, i) => (i === index ? { ...n, ...patch } : n)),
        },
      };
    });
  },

  setIsPickingCloneSource(picking: boolean): void {
    useToolStore.setState({ isPickingCloneSource: picking });
  },

  setCloneSourceAnchor(anchor: Point2D | null): void {
    useToolStore.setState({ cloneSourceAnchor: anchor });
  },

  setActivePenSessionMeta(
    pointCount: number,
    closed: boolean,
    selectedAnchor: number | null
  ): void {
    useToolStore.setState({
      activePenPointCount: pointCount,
      activePenClosed: closed,
      activePenSelectedAnchor: selectedAnchor,
    });
  },
};

export interface InteractiveToolActionsBridge {
  initGradientMesh?: () => void;
  applyGradientMesh?: () => void;
  cancelGradientMesh?: () => void;
  commitPenPath?: () => void;
  cancelPenPath?: () => void;
  toggleClosePenPath?: () => void;
  deleteSelectedPenAnchor?: () => void;
  toggleSelectedPenAnchorSmooth?: () => void;
}

export const interactiveToolBridge: InteractiveToolActionsBridge = {};
