import { useState, useCallback, useEffect, useRef, useMemo } from 'react';
import {
  ToolType,
  BrushSettings,
  CanvasDimensions,
  CanvasColorMode,
  MenuSection,
  NewCanvasOptions,
  DocumentTab,
  LayerItem,
  CanvasSelection,
  TransformSession,
  FillSettings,
  TextSettings,
  FrameSettings,
  ExpressionColor,
  LiquifySettings,
  WandSettings,
  AdjustmentLayerData,
  FilterType,
  BalloonSettings,
  VectorEditSettings,
  SpeechBalloon,
  AnimationTimeline,
  CmykStandard,
  SoftProofSettings,
  DEFAULT_SOFT_PROOF_SETTINGS,
} from './types/editor';
import {
  createDefaultAnimationTimeline,
  setFrameCel,
  removeFrameCel,
} from './utils/animationEngine';
import { applyLiquifyStep, createLiquifySelectionMask, DirtyRect } from './utils/liquifyEngine';
import { PerspectiveRuler, ConstraintAxis } from './types/perspective';
import { createDefaultPerspectiveRuler, applyWormsEyePreset } from './utils/perspectiveMath';
import { executeFloodFill, compositeVisibleLayers, compositeReferenceLayers, executeLassoFill } from './utils/floodFill';
import {
  isPointInSelection,
  liftSelectionToFloating,
  commitFloatingSelection,
  computePolygonBounds,
  getCanvasContentBounds,
  floodSelectWand,
  expandSelection,
  contractSelection,
  featherSelection,
  invertSelection,
  selectionToMask,
  maskToBounds,
  maskToSvgPath,
} from './utils/selectionUtils';
import {
  renderPerspectiveQuad,
  renderMeshWarp,
  createDefaultPerspectiveQuad,
  createDefaultMeshPoints,
} from './utils/transformEngine';
import { applyScreentone } from './utils/screentoneEngine';
import { applyLayerEffects } from './utils/layerEffectsEngine';
import { useCanvasDrawing } from './hooks/useCanvasDrawing';
import { useCanvasNavigation } from './hooks/useCanvasNavigation';
import { useLayerManager } from './hooks/useLayerManager';
import { enforceColorMode } from './utils/colorUtils';
import { openFile } from './utils/imageLoader';
import {
  promptSaveAs,
  saveToExistingHandle,
  promptExportPngImage,
  compositeCanvas,
  SaveDocumentData,
  SavedFileInfo,
} from './utils/saveManager';
import { Header } from './components/Header';
import { LeftPanel } from './components/LeftPanel';
import { CanvasArea } from './components/CanvasArea';
import { RightSidebar } from './components/RightSidebar';
import { NewCanvasModal } from './components/NewCanvasModal';
import { ResizeCanvasModal } from './components/ResizeCanvasModal';
import { SettingsModal } from './components/SettingsModal';
import { useMultiplayer } from './hooks/useMultiplayer';
import { multiplayerService } from './services/multiplayerService';
import { HostModal } from './components/HostModal';
import { ClipboardInviteToast } from './components/ClipboardInviteToast';
import { WebLandingModal } from './components/WebLandingModal';
import { WelcomeScreen } from './components/WelcomeScreen';
import { AdjustmentModal } from './components/AdjustmentModal';
import { LayerStylesModal } from './components/LayerStylesModal';
import { recoveryService, CrashedSessionInfo } from './services/recoveryService';
import { CrashRecoveryModal } from './components/CrashRecoveryModal';
import { applyFilter } from './utils/filterEngine';
import { saveRecentDocument, RecentDocument } from './utils/recentDocumentsManager';
import {
  renderCompleteStroke,
  drawDot,
  drawSmoothBezierSegment,
  getMidPoint,
  get2DContext,
  getReusableBakeCanvas,
  screenToCanvas,
  sampleCompositedColor,
} from './utils/canvasUtils';
import { globalTileGrid, globalTileMemoryManager } from './utils/tileEngine';
import { getNextCollabLayerName } from './hooks/useLayerManager';
import { drawPencilDot, drawPencilBezierSegment, PencilGrade } from './utils/pencilEngine';
import { Point } from './types/editor';
import {
  StrokeStartMessage,
  StrokeChunkMessage,
  StrokeFinishMessage,
  MultiplayerMessage,
} from './types/multiplayer';
import {
  renderVectorStroke,
  renderVectorLayer,
  pinchVectorStroke,
  modifyStrokeWidth,
  simplifyVectorStroke,
} from './utils/vectorEngine';
import { renderMangaTextToCanvas } from './utils/mangaTextEngine';
import { createDefaultSpeechBalloon, renderSpeechBalloon } from './utils/balloonEngine';
import {
  renderSaturatedLines,
  renderStreamLines,
  SaturatedLinesOptions,
  StreamLinesOptions,
} from './utils/mangaEffectsEngine';
import { MangaEffectsModal } from './components/MangaEffectsModal';
import { WebtoonExportModal } from './components/WebtoonExportModal';

import {
  AppSettings,
  loadAppSettings,
  saveAppSettings,
  ResizeCanvasOptions,
  resolveModernAccentColor,
  getAccentContrastColor,
  hexToRgb,
} from './types/settings';
import {
  FilePlus,
  FolderOpen,
  Save,
  Download,
  Trash2,
  Film,
  Layers,
  Undo2,
  Redo2,
  ZoomIn,
  ZoomOut,
  RotateCcw,
  Plus,
  Loader2,
  Info as InfoIcon,
  CheckCircle2,
  Copy,
  ClipboardPaste,
  ImagePlus,
  Scaling,
  Settings,
  FolderDown,
  PaintBucket,
  SlidersHorizontal,
  Compass,
  Eye,
  EyeOff,
  Magnet,
  Lock,
  Unlock,
  Box,
  Maximize2,
  Minimize2,
  Feather,
  BoxSelect,
  X,
  Smartphone,
  Archive,
  Sparkles,
  MessageSquare,
  Spline,
} from 'lucide-react';
import { parseSutFile } from './utils/sutParser';
import {
  saveCustomBrush,
  prepareBrushSettingsForCsp,
  deleteCustomBrush,
  loadCustomBrushes,
} from './utils/brushStorage';
import {
  saveBrushSettingsDebounced,
  flushPendingBrushSettingsSave,
  stepBrushSizePreset,
  getEffectiveBrushSettings,
  getActivePresetId,
  saveActivePresetId,
  ERASER_PRESET_ID,
  DEFAULT_BRUSH_PRESET_ID,
} from './utils/brushPresetManager';
import { TonalCorrectionModal } from './components/TonalCorrectionModal';
import { SimpleToneModal, SimpleToneSettings } from './components/SimpleToneModal';
import {
  TonalCorrectionType,
  applyTonalFilter,
  applyReverseGradient,
  createSelectionMask,
  getProcessingBounds,
  ProcessingBounds,
} from './utils/tonalEngine';

const INITIAL_DIMENSIONS: CanvasDimensions = {
  width: 1440,
  height: 900,
  dpi: 300,
};

export function App() {
  const [tool, setTool] = useState<ToolType>('brush');
  const toolRef = useRef<ToolType>(tool);
  useEffect(() => {
    toolRef.current = tool;
  }, [tool]);

  const previousToolBeforeAltRef = useRef<ToolType | null>(null);
  const isAltActiveRef = useRef<boolean>(false);
  const isPipetteSamplingRef = useRef<boolean>(false);

  // Selection state
  const [selection, setSelection] = useState<CanvasSelection | null>(null);

  // Free Transform session state
  const [transformSession, setTransformSession] = useState<TransformSession | null>(null);

  // Magic Wand tool settings
  const [wandSettings, setWandSettings] = useState<WandSettings>({
    tolerance: 32,
    contiguous: true,
    antiAlias: true,
    referMode: 'active',
  });
  const selectionMaskCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const selectionPenDrawingRef = useRef<{
    isDrawing: boolean;
    lastPt: { x: number; y: number };
    maskCanvas: HTMLCanvasElement;
    ctx: CanvasRenderingContext2D;
  } | null>(null);

  // Fill tool settings
  const [fillSettings, setFillSettings] = useState<FillSettings>({
    method: 'refer-all',
    tolerance: 32,
  });

  // Text tool settings & active text placement session
  const [textSettings, setTextSettings] = useState<TextSettings>({
    text: '',
    fontFamily: "'Neucha', 'Anime Ace', 'Comic Sans MS', sans-serif",
    fontSize: 28,
    bold: false,
    italic: false,
    align: 'center',
    outline: true,
    outlineColor: '#ffffff',
    outlineWidth: 3,
    color: '#000000',
  });
  const [textSession, setTextSession] = useState<{ x: number; y: number; settings: TextSettings } | null>(null);
  const [is3DLayerOpen, setIs3DLayerOpen] = useState<boolean>(false);

  // Frame Border tool settings
  const [frameSettings, setFrameSettings] = useState<FrameSettings>({
    thickness: 4,
    fillBackground: true,
    fillColor: '#ffffff',
  });

  // Speech Balloon tool settings & active placement session
  const [balloonSettings, setBalloonSettings] = useState<BalloonSettings>({
    shape: 'ellipse',
    fillColor: '#ffffff',
    strokeColor: '#000000',
    strokeWidth: 3,
    text: '',
    fontFamily: "'Neucha', 'Anime Ace', 'Comic Sans MS', sans-serif",
    fontSize: 22,
    vertical: false,
  });
  const [activeBalloon, setActiveBalloon] = useState<SpeechBalloon | null>(null);

  // Vector "Correct Line" tool settings
  const [vectorEditSettings, setVectorEditSettings] = useState<VectorEditSettings>({
    mode: 'pinch',
    radius: 35,
    pinchStrength: 1.0,
    widthFactor: 1.5,
    simplifyTolerance: 2.0,
  });

  // Webtoon Studio Mode state
  const [isWebtoonMode, setIsWebtoonMode] = useState<boolean>(false);
  const [isWebtoonExportModalOpen, setIsWebtoonExportModalOpen] = useState<boolean>(false);

  // Manga Effect Lines Modal state
  const [isMangaEffectsModalOpen, setIsMangaEffectsModalOpen] = useState<boolean>(false);

  // Liquify tool settings
  const [liquifySettings, setLiquifySettings] = useState<LiquifySettings>(() => {
    try {
      const saved = localStorage.getItem('sora_paint_liquify_settings');
      if (saved) return JSON.parse(saved);
    } catch {}
    return {
      mode: 'push',
      size: 80,
      strength: 50,
      hardness: 50,
      usePressure: true,
    };
  });
  const liquifySettingsRef = useRef<LiquifySettings>(liquifySettings);
  useEffect(() => {
    liquifySettingsRef.current = liquifySettings;
  }, [liquifySettings]);

  const handleUpdateLiquifySettings = useCallback((newSettings: Partial<LiquifySettings>) => {
    setLiquifySettings((prev) => {
      const next = { ...prev, ...newSettings };
      try {
        localStorage.setItem('sora_paint_liquify_settings', JSON.stringify(next));
      } catch {}
      return next;
    });
  }, []);

  const isLiquifyingRef = useRef<boolean>(false);
  const prevLiquifyPointRef = useRef<{ x: number; y: number } | null>(null);
  const liquifyBeforeImageDataRef = useRef<ImageData | null>(null);
  const liquifyInitialImageDataRef = useRef<ImageData | null>(null);

  const isVectorEditingRef = useRef<boolean>(false);
  const lastVectorEditPtRef = useRef<{ x: number; y: number } | null>(null);
  const vectorEditBeforeStrokesRef = useRef<any[] | null>(null);
  const liquifyDirtyRectRef = useRef<DirtyRect | null>(null);
  const liquifyRafIdRef = useRef<number | null>(null);
  const liquifyLastPointerPosRef = useRef<{ pt: { x: number; y: number }; pressure: number } | null>(null);
  const liquifySelectionMaskRef = useRef<Uint8Array | null>(null);

  // Tool interaction tracking refs
  const selectionDragRef = useRef<{
    isDragging: boolean;
    startX: number;
    startY: number;
    origFloatingX: number;
    origFloatingY: number;
    origBoundsX: number;
    origBoundsY: number;
  } | null>(null);
  const selectRectStartRef = useRef<{ x: number; y: number } | null>(null);
  const lassoPointsRef = useRef<Array<{ x: number; y: number }>>([]);
  const lassoFillPointsRef = useRef<Array<{ x: number; y: number }>>([]);
  const frameStartRef = useRef<{ x: number; y: number } | null>(null);
  const [dimensions, setDimensions] = useState<CanvasDimensions>(INITIAL_DIMENSIONS);
  const [colorMode, setColorMode] = useState<CanvasColorMode>('color');
  const [documentName, setDocumentName] = useState<string>('');

  // CMYK Soft Proofing & Gamut Warning
  const [softProofSettings, setSoftProofSettings] = useState<SoftProofSettings>(DEFAULT_SOFT_PROOF_SETTINGS);

  const toggleSoftProof = useCallback(() => {
    setSoftProofSettings((prev) => ({
      ...prev,
      enabled: !prev.enabled,
    }));
  }, []);

  const toggleGamutWarning = useCallback(() => {
    setSoftProofSettings((prev) => ({
      ...prev,
      gamutWarning: !prev.gamutWarning,
    }));
  }, []);

  const setProofStandard = useCallback((standard: CmykStandard) => {
    setSoftProofSettings((prev) => ({
      ...prev,
      standard,
    }));
  }, []);

  // Multi-document tab management (starts empty by default)
  const [documents, setDocuments] = useState<DocumentTab[]>([]);
  const [activeDocumentId, setActiveDocumentId] = useState<string | null>(null);
  const hasOpenDocument = Boolean(activeDocumentId && documents.some((d) => d.id === activeDocumentId));
  const [appView, setAppView] = useState<'home' | 'workspace'>('workspace');

  // Panels width & visibility (compact defaults dedicating >80% viewport to canvas)
  const [leftPanelWidth, setLeftPanelWidth] = useState<number>(() => {
    const s = localStorage.getItem('ink_left_panel_width_v3');
    return s ? Number(s) : 118;
  });
  const [isLeftPanelHidden, setIsLeftPanelHidden] = useState<boolean>(false);
  const [isRightSidebarHidden, setIsRightSidebarHidden] = useState<boolean>(false);
  const [rightSidebarWidth, setRightSidebarWidth] = useState<number>(() => {
    const s = localStorage.getItem('ink_right_sidebar_width_v3');
    return s ? Number(s) : 162;
  });

  const handleLeftPanelWidthChange = useCallback((w: number) => {
    setLeftPanelWidth(w);
    localStorage.setItem('ink_left_panel_width_v3', String(w));
  }, []);

  const handleRightSidebarWidthChange = useCallback((w: number) => {
    setRightSidebarWidth(w);
    localStorage.setItem('ink_right_sidebar_width_v3', String(w));
  }, []);

  const draftCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const strokeCanvasRef = draftCanvasRef; // Backwards-compatible alias

  const [savedFileInfo, setSavedFileInfo] = useState<SavedFileInfo | null>(null);
  const [toastMessage, setToastMessage] = useState<string | null>(null);
  const toastTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const [appSettings, setAppSettings] = useState<AppSettings>(loadAppSettings);

  useEffect(() => {
    const accent = appSettings.modernAccent || 'neutral';
    const hex = resolveModernAccentColor(accent, appSettings.modernCustomColor);
    const rgb = hexToRgb(hex) || { r: 229, g: 229, b: 229 };
    const contrast = getAccentContrastColor(hex);

    const root = document.documentElement;
    root.setAttribute('data-theme', 'modern');
    root.setAttribute('data-accent', accent);
    root.style.setProperty('--accent', hex);
    root.style.setProperty('--accent-rgb', `${rgb.r}, ${rgb.g}, ${rgb.b}`);
    root.style.setProperty('--accent-contrast', contrast);
    root.style.setProperty('--accent-subtle', `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, 0.14)`);
    root.style.setProperty('--accent-border', `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, 0.32)`);
    root.style.setProperty('--modern-accent', hex);
    root.style.setProperty('--modern-accent-rgb', `${rgb.r}, ${rgb.g}, ${rgb.b}`);
    root.style.setProperty('--modern-accent-subtle', `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, 0.14)`);
    root.style.setProperty('--modern-accent-border', `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, 0.32)`);
    root.style.setProperty('--modern-accent-hover', `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, 0.2)`);
  }, [appSettings.modernAccent, appSettings.modernCustomColor]);

  const [isNewCanvasModalOpen, setIsNewCanvasModalOpen] = useState<boolean>(false);
  const [isResizeCanvasModalOpen, setIsResizeCanvasModalOpen] = useState<boolean>(false);
  const [isSettingsModalOpen, setIsSettingsModalOpen] = useState<boolean>(false);
  const [isToneModalOpen, setIsToneModalOpen] = useState<boolean>(false);
  const [tonalModalState, setTonalModalState] = useState<{
    isOpen: boolean;
    type: TonalCorrectionType;
    targetLayerId: string;
    beforeImageData: ImageData | null;
    selectionMask: Uint8Array | null;
    bounds: ProcessingBounds;
  }>({
    isOpen: false,
    type: 'brightness-contrast',
    targetLayerId: '',
    beforeImageData: null,
    selectionMask: null,
    bounds: { x0: 0, y0: 0, x1: 0, y1: 0 },
  });
  const tonalModalStateRef = useRef(tonalModalState);
  useEffect(() => {
    tonalModalStateRef.current = tonalModalState;
  }, [tonalModalState]);
  const [isLoadingFile, setIsLoadingFile] = useState<boolean>(false);
  const [loadingStatus, setLoadingStatus] = useState<string>('');

  // Fault-Tolerant Crash Recovery (WAL Architecture) State
  const [crashedSessions, setCrashedSessions] = useState<CrashedSessionInfo[]>([]);
  const [isRecoveryModalOpen, setIsRecoveryModalOpen] = useState<boolean>(false);

  // Crash Recovery: detect unfinalized crashed sessions on startup
  useEffect(() => {
    recoveryService
      .checkForCrashedSessions()
      .then((sessions) => {
        if (sessions && sessions.length > 0) {
          setCrashedSessions(sessions);
          setIsRecoveryModalOpen(true);
        }
      })
      .catch((err) => {
        console.warn('[Recovery] Error scanning for crashed sessions:', err);
      });
  }, []);


  const fileInputRef = useRef<HTMLInputElement>(null);
  const pasteFileInputRef = useRef<HTMLInputElement>(null);
  const import3DFileInputRef = useRef<HTMLInputElement>(null);
  const [initial3DFile, setInitial3DFile] = useState<File | null>(null);

  const [perspectiveRuler, setPerspectiveRuler] = useState<PerspectiveRuler | null>(null);
  const [activeLockedAxis, setActiveLockedAxis] = useState<ConstraintAxis | null>(null);

  const handleActiveConstraintAxisChange = useCallback((newAxis: ConstraintAxis | null) => {
    setActiveLockedAxis((prev) => {
      if (prev === newAxis) return prev;
      if (
        prev &&
        newAxis &&
        prev.type === newAxis.type &&
        prev.origin.x === newAxis.origin.x &&
        prev.origin.y === newAxis.origin.y &&
        prev.dir.x === newAxis.dir.x &&
        prev.dir.y === newAxis.dir.y
      ) {
        return prev;
      }
      return newAxis;
    });
  }, []);

  const updatePerspectiveRuler = useCallback(
    (
      updater:
        | PerspectiveRuler
        | null
        | ((prev: PerspectiveRuler | null) => PerspectiveRuler | null)
    ) => {
      setPerspectiveRuler((prev) => {
        const next = typeof updater === 'function' ? updater(prev) : updater;
        if (activeDocumentId) {
          setDocuments((docs) =>
            docs.map((d) => (d.id === activeDocumentId ? { ...d, perspectiveRuler: next } : d))
          );
        }
        return next;
      });
    },
    [activeDocumentId]
  );

  const showToast = useCallback((msg: string) => {
    if (toastTimeoutRef.current) clearTimeout(toastTimeoutRef.current);
    setToastMessage(msg);
    toastTimeoutRef.current = setTimeout(() => setToastMessage(null), 3200);
  }, []);

  const [primaryColor, setPrimaryColor] = useState<string>('#000000');
  const [secondaryColor, setSecondaryColor] = useState<string>('#ffffff');
  const [recentColors, setRecentColors] = useState<string[]>([
    '#000000',
    '#3b82f6',
    '#ef4444',
    '#10b981',
    '#f59e0b',
    '#ffffff',
  ]);

  const [brushSettings, setBrushSettings] = useState<BrushSettings>(() => {
    const activePreset = getActivePresetId();
    const effective = getEffectiveBrushSettings(activePreset);
    return {
      preset: activePreset,
      size: effective.size ?? 3.5,
      minSizeFactor: effective.minSizeFactor ?? 0.25,
      color: '#000000',
      secondaryColor: '#ffffff',
      opacity: effective.opacity ?? 1.0,
      flow: effective.flow ?? 0.74,
      spacing: effective.spacing ?? 0.08,
      grain: effective.grain ?? 0.95,
      usePressure: effective.usePressure ?? true,
      smoothing: effective.smoothing ?? true,
      stabilization: effective.stabilization ?? 15,
      hardness: effective.hardness ?? 0.8,
      ...effective,
    } as BrushSettings;
  });

  // Layer Management System
  const {
    layers,
    setLayers,
    activeLayerId,
    setActiveLayerId,
    selectedLayerIds,
    toggleLayerSelection,
    deleteSelectedLayers,
    groupSelectedLayers,
    activeLayer,
    layerCanvasesRef,
    registerLayerCanvas,
    updateLayerThumbnail,
    addLayer,
    addRemoteLayer,
    deleteRemoteLayer,
    syncRemoteDocument,
    duplicateLayer,
    deleteLayer,
    copyLayer,
    pasteLayer,
    pasteLayerFromCanvas,
    pasteLayerFromFile,
    resizeCanvas,
    toggleVisibility,
    setOpacity,
    setBlendMode,
    toggleLock,
    toggleCollapse,
    renameLayer,
    moveLayer,
    moveLayerToFolder,
    reorderLayers,
    getEffectiveOpacity,
    isLayerEffectivelyVisible,
    clearActiveLayer,
    resetToNewCanvas,
    setDefaultToneFrequency,
    clearDocument,
    loadDocument,
    layerSourceCanvasesRef,
    toggleTone,
    setToneFrequency,
    setToneAngle,
    setToneDotShape,
    setToneDensity,
    setToneDensityType,
    toggleLayerColor,
    setLayerColor,
    setLayerSubColor,
    setLayerExpressionColor,
    setLayerMonoThreshold,
    setLayerMonoExpressMode,
    applyExpressionColorOfPreview,
    applyLayerColorPermanently,
    toggleClipping,
    toggleAlphaLock,
    convertLayer,
    fillScreentoneSelection,
    addLayerMask,
    removeLayerMask,
    toggleLayerMask,
    toggleMaskLinked,
    updateMaskThumbnail,
    addAdjustmentLayer,
    updateAdjustmentData,
    updateLayerStyles,
  } = useLayerManager({ dimensions, activeSessionId: activeDocumentId });

  // Synchronize active document recovery session and WAL periodic checkpointing
  const recoveryStateRef = useRef({
    documents,
    documentName,
    dimensions,
    colorMode,
    layers,
    activeLayerId,
  });
  recoveryStateRef.current = {
    documents,
    documentName,
    dimensions,
    colorMode,
    layers,
    activeLayerId,
  };

  useEffect(() => {
    if (!activeDocumentId) return;
    const st = recoveryStateRef.current;
    const initDoc = st.documents.find((d) => d.id === activeDocumentId);
    if (!initDoc) return;

    recoveryService.initSession(
      activeDocumentId,
      () => {
        const cur = recoveryStateRef.current;
        const doc = cur.documents.find((d) => d.id === activeDocumentId);
        return {
          sessionId: activeDocumentId,
          documentName: doc?.name || cur.documentName || 'Untitled Document',
          width: doc?.dimensions.width || cur.dimensions.width,
          height: doc?.dimensions.height || cur.dimensions.height,
          dpi: doc?.dimensions.dpi || cur.dimensions.dpi || 600,
          colorMode: doc?.colorMode || cur.colorMode || 'color',
          layers: doc?.layers || cur.layers,
          activeLayerId: doc?.activeLayerId || cur.activeLayerId,
          timestamp: Date.now(),
        };
      },
      async () => {
        const cur = recoveryStateRef.current;
        const doc = cur.documents.find((d) => d.id === activeDocumentId);
        const targetLayerId = doc?.activeLayerId || cur.activeLayerId;
        const dims = doc?.dimensions || cur.dimensions;
        if (!targetLayerId || dims.width <= 0 || dims.height <= 0) return null;
        try {
          const thumbW = 120;
          const thumbH = Math.max(68, Math.round((dims.height / Math.max(1, dims.width)) * thumbW));
          const dataUrl = globalTileGrid.generateThumbnail(targetLayerId, thumbW, thumbH, dims);
          const commaIdx = dataUrl.indexOf(',');
          if (commaIdx < 0) return null;
          const b64 = dataUrl.slice(commaIdx + 1);
          const binStr = atob(b64);
          const bytes = new Uint8Array(binStr.length);
          for (let i = 0; i < binStr.length; i++) {
            bytes[i] = binStr.charCodeAt(i);
          }
          return bytes;
        } catch {
          return null;
        }
      }
    );
  }, [activeDocumentId, layerCanvasesRef]);

  // Active edit target for painting/erasing ('layer' content vs 'mask')
  const [activeEditTarget, setActiveEditTarget] = useState<'layer' | 'mask'>('layer');

  // 2D Frame-by-Frame Animation Timeline State
  const [animationTimeline, setAnimationTimeline] = useState<AnimationTimeline | null>(null);

  const activeDoc = documents.find((d) => d.id === activeDocumentId);
  const activeAnimationTimeline = activeDoc?.animation !== undefined ? activeDoc.animation : animationTimeline;

  const handleUpdateAnimationTimeline = useCallback(
    (timeline: AnimationTimeline | null) => {
      setAnimationTimeline(timeline);
      if (activeDocumentId) {
        setDocuments((docs) =>
          docs.map((d) => (d.id === activeDocumentId ? { ...d, animation: timeline } : d))
        );
      }
    },
    [activeDocumentId]
  );

  const handleAddAnimationCel = useCallback(
    (frameIndex: number) => {
      const newLayerId = `layer-cel-${Date.now()}-${Math.random().toString(36).substring(2, 6)}`;
      const newCelLayer: LayerItem = {
        id: newLayerId,
        name: `Cel Frame ${frameIndex + 1}`,
        type: 'raster',
        visible: true,
        opacity: 1,
        blendMode: 'normal',
        locked: false,
        collapsed: false,
        parentId: null,
      };

      const canvas = document.createElement('canvas');
      canvas.width = dimensions.width;
      canvas.height = dimensions.height;
      registerLayerCanvas(newLayerId, canvas);

      setLayers((prev) => [newCelLayer, ...prev]);
      setActiveLayerId(newLayerId);

      const currentTl = activeAnimationTimeline || createDefaultAnimationTimeline(layers);
      const updatedTl = setFrameCel(currentTl, frameIndex, newLayerId);
      handleUpdateAnimationTimeline(updatedTl);
      showToast(`Cel added for frame ${frameIndex + 1}`);
    },
    [activeAnimationTimeline, dimensions, handleUpdateAnimationTimeline, layers, registerLayerCanvas, setActiveLayerId, setLayers, showToast]
  );

  const handleDeleteAnimationCel = useCallback(
    (frameIndex: number) => {
      if (!activeAnimationTimeline) return;
      const updatedTl = removeFrameCel(activeAnimationTimeline, frameIndex);
      handleUpdateAnimationTimeline(updatedTl);
      showToast(`Cel removed from frame ${frameIndex + 1}`);
    },
    [activeAnimationTimeline, handleUpdateAnimationTimeline, showToast]
  );

  // Adjustment Layer Modal state
  const [adjustmentModalState, setAdjustmentModalState] = useState<{
    isOpen: boolean;
    layerId?: string | null;
    initialType?: 'curves' | 'gradient-map' | 'levels' | 'color-balance';
  }>({
    isOpen: false,
  });

  const handleOpenAdjustmentModal = useCallback(
    (layerId?: string, initialType: 'curves' | 'gradient-map' | 'levels' | 'color-balance' = 'curves') => {
      setAdjustmentModalState({
        isOpen: true,
        layerId: layerId || null,
        initialType,
      });
    },
    []
  );

  const handleApplyAdjustment = useCallback(
    (type: 'curves' | 'gradient-map' | 'levels' | 'color-balance', data: AdjustmentLayerData) => {
      if (adjustmentModalState.layerId) {
        updateAdjustmentData(adjustmentModalState.layerId, data);
        showToast(`Updated ${data.type} adjustment layer`);
      } else {
        addAdjustmentLayer(type, data);
        showToast(`Created new ${data.type} adjustment layer`);
      }
      setAdjustmentModalState({ isOpen: false });
    },
    [adjustmentModalState.layerId, updateAdjustmentData, addAdjustmentLayer, showToast]
  );

  // Non-Destructive GPU Layer Styles Modal State (Stroke, Drop Shadow, Outer Glow)
  const [layerStylesModalState, setLayerStylesModalState] = useState<{
    isOpen: boolean;
    layerId?: string | null;
  }>({
    isOpen: false,
  });

  const handleOpenLayerStylesModal = useCallback(
    (layerId?: string) => {
      const targetId = layerId || activeLayerId;
      if (targetId) {
        setLayerStylesModalState({
          isOpen: true,
          layerId: targetId,
        });
      }
    },
    [activeLayerId]
  );

  const handleApplyLayerStyles = useCallback(
    (styles: any) => {
      if (layerStylesModalState.layerId) {
        updateLayerStyles(layerStylesModalState.layerId, styles);
        showToast('Updated Layer Styles');
      }
      setLayerStylesModalState({ isOpen: false });
    },
    [layerStylesModalState.layerId, updateLayerStyles, showToast]
  );

  const pushHistoryStepRef = useRef<any>(null);

  const handleApplyFilter = useCallback(
    (type: FilterType, params?: any) => {
      if (!hasOpenDocument || !activeLayer || activeLayer.type !== 'raster' || activeLayer.locked) {
        showToast('Select an unlocked raster layer to apply filter');
        return;
      }
      const isTone = Boolean(activeLayer.toneEnabled && layerSourceCanvasesRef.current?.get(activeLayerId));
      const sourceCanvas = layerSourceCanvasesRef.current?.get(activeLayerId);
      const displayCanvas = layerCanvasesRef.current.get(activeLayerId);
      const targetCanvas = isTone && sourceCanvas ? sourceCanvas : displayCanvas;
      if (!targetCanvas || !displayCanvas) return;
      const ctx = get2DContext(targetCanvas);
      if (!ctx) return;

      const beforeImageData = ctx.getImageData(0, 0, targetCanvas.width, targetCanvas.height);
      const rawFiltered = applyFilter(
        new ImageData(new Uint8ClampedArray(beforeImageData.data), beforeImageData.width, beforeImageData.height),
        type,
        params
      );

      let finalImageData = rawFiltered;
      if (selection) {
        const selMask = createSelectionMask(selection, targetCanvas.width, targetCanvas.height);
        if (selMask) {
          finalImageData = new ImageData(new Uint8ClampedArray(beforeImageData.data), targetCanvas.width, targetCanvas.height);
          const src = beforeImageData.data;
          const flt = rawFiltered.data;
          const dst = finalImageData.data;
          for (let i = 0; i < selMask.length; i++) {
            const m = selMask[i];
            if (m === 0) continue;
            const p = i * 4;
            if (m === 255) {
              dst[p] = flt[p];
              dst[p + 1] = flt[p + 1];
              dst[p + 2] = flt[p + 2];
              dst[p + 3] = flt[p + 3];
            } else {
              const a = m / 255;
              const inv = 1 - a;
              dst[p] = Math.round(src[p] * inv + flt[p] * a);
              dst[p + 1] = Math.round(src[p + 1] * inv + flt[p + 1] * a);
              dst[p + 2] = Math.round(src[p + 2] * inv + flt[p + 2] * a);
              dst[p + 3] = Math.round(src[p + 3] * inv + flt[p + 3] * a);
            }
          }
        }
      }

      ctx.putImageData(finalImageData, 0, 0);

      if (!isTone && sourceCanvas) {
        get2DContext(sourceCanvas)?.putImageData(finalImageData, 0, 0);
      }

      if (isTone && sourceCanvas) {
        applyLayerEffects(sourceCanvas, displayCanvas, activeLayer, dimensions.dpi ?? 600);
      } else {
        const isMono = colorMode === 'monochrome' || activeLayer.expressionColor === 'monochrome';
        const targetFormat = isMono ? 'monochrome-1bit' : 'color-32bit';
        globalTileGrid.writeImageData(activeLayerId, finalImageData, 0, 0, targetFormat);
      }

      pushHistoryStepRef.current?.(
        'filter',
        `Filter: ${type.replace('-', ' ')}`,
        beforeImageData,
        finalImageData,
        activeLayerId
      );
      globalTileGrid.notifyChange(true);
      updateLayerThumbnail(activeLayerId, true);
      showToast(`Filter applied: ${type.replace('-', ' ')}`);
    },
    [hasOpenDocument, activeLayer, activeLayerId, selection, dimensions.dpi, layerCanvasesRef, layerSourceCanvasesRef, colorMode, updateLayerThumbnail, showToast]
  );

  const {
    viewportRef,
    zoom,
    pan,
    rotation,
    isSpaceDown,
    isShiftDown,
    isRotateModifier,
    isPanning,
    isRotating,
    startPan,
    startRotate,
    zoomIn,
    zoomOut,
    resetZoomAndCenter,
    resetRotation,
  } = useCanvasNavigation({
    dimensions,
    isWebtoonMode,
    activeDocumentId,
  });

  // Remote multiplayer draft overlays and stroke states
  const remoteDraftCanvasesRef = useRef<Map<string | number, HTMLCanvasElement>>(new Map());
  const remoteStrokeStatesRef = useRef<
    Map<
      string,
      {
        brushSettings: BrushSettings;
        tool: ToolType;
        points: Point[];
        layerId: string;
        peerId: string | number;
      }
    >
  >(new Map());

  const handleRemoteStrokeStart = useCallback((msg: StrokeStartMessage) => {
    remoteStrokeStatesRef.current.set(msg.strokeId, {
      brushSettings: msg.brushSettings,
      tool: msg.tool,
      points: [msg.startPoint],
      layerId: msg.layerId,
      peerId: msg.peerId,
    });

    const draftCanvas = remoteDraftCanvasesRef.current.get(msg.peerId);
    if (!draftCanvas) return;
    const ctx = get2DContext(draftCanvas);
    if (!ctx) return;

    ctx.clearRect(0, 0, draftCanvas.width, draftCanvas.height);
    const bs = msg.brushSettings;
    const isEraser = msg.tool === 'eraser';
    const isBgEraser = isEraser && (msg.layerId === 'layer-bg' || msg.layerId.startsWith('layer-bg'));
    const isPencil = !isEraser && (bs.preset?.startsWith('pencil') ?? false);
    const strokeColor = isBgEraser ? '#ffffff' : enforceColorMode(bs.color, colorMode);

    if (isPencil) {
      drawPencilDot(
        ctx,
        msg.startPoint,
        strokeColor,
        (bs.preset as PencilGrade) || 'pencil-2b',
        bs.flow ?? 0.74,
        bs.grain ?? 1.0,
        bs.hardness
      );
    } else {
      drawDot(
        ctx,
        msg.startPoint,
        strokeColor,
        isEraser && !isBgEraser,
        colorMode === 'monochrome' ? 1.0 : (bs.hardness ?? 1.0),
        bs.flow ?? 1.0
      );
    }
  }, [colorMode]);

  const handleRemoteStrokeChunk = useCallback((msg: StrokeChunkMessage) => {
    const strokeState = remoteStrokeStatesRef.current.get(msg.strokeId);
    if (!strokeState) return;

    const draftCanvas = remoteDraftCanvasesRef.current.get(msg.peerId);
    if (!draftCanvas) return;
    const ctx = get2DContext(draftCanvas);
    if (!ctx) return;

    const bs = strokeState.brushSettings;
    const isEraser = strokeState.tool === 'eraser';
    const isBgEraser = isEraser && (strokeState.layerId === 'layer-bg' || strokeState.layerId.startsWith('layer-bg'));
    const isPencil = !isEraser && (bs.preset?.startsWith('pencil') ?? false);
    const strokeColor = isBgEraser ? '#ffffff' : enforceColorMode(bs.color, colorMode);
    const pts = strokeState.points;

    for (let i = 0; i < msg.points.length; i++) {
      const pt = msg.points[i];
      pts.push(pt);

      if (isPencil) {
        if (pts.length >= 3) {
          const p0 = pts[pts.length - 3];
          const p1 = pts[pts.length - 2];
          const p2 = pts[pts.length - 1];
          drawPencilBezierSegment(
            ctx,
            getMidPoint(p0, p1),
            p1,
            getMidPoint(p1, p2),
            strokeColor,
            (bs.preset as PencilGrade) || 'pencil-2b',
            bs.flow ?? 0.74,
            bs.grain ?? 1.0,
            bs.hardness
          );
        } else if (pts.length === 2) {
          drawPencilBezierSegment(
            ctx,
            pts[0],
            pts[0],
            getMidPoint(pts[0], pts[1]),
            strokeColor,
            (bs.preset as PencilGrade) || 'pencil-2b',
            bs.flow ?? 0.74,
            bs.grain ?? 1.0,
            bs.hardness
          );
        }
      } else if (bs.smoothing) {
        if (pts.length >= 3) {
          const p0 = pts[pts.length - 3];
          const p1 = pts[pts.length - 2];
          const p2 = pts[pts.length - 1];
          drawSmoothBezierSegment(
            ctx,
            getMidPoint(p0, p1),
            p1,
            getMidPoint(p1, p2),
            strokeColor,
            isEraser && !isBgEraser,
            colorMode === 'monochrome' ? 1.0 : (bs.hardness ?? 1.0),
            bs.flow ?? 1.0,
            bs.spacing ?? 0.1
          );
        } else if (pts.length === 2) {
          drawSmoothBezierSegment(
            ctx,
            pts[0],
            pts[0],
            getMidPoint(pts[0], pts[1]),
            strokeColor,
            isEraser && !isBgEraser,
            colorMode === 'monochrome' ? 1.0 : (bs.hardness ?? 1.0),
            bs.flow ?? 1.0,
            bs.spacing ?? 0.1
          );
        }
      } else {
        if (pts.length >= 2) {
          const pPrev = pts[pts.length - 2];
          const pCurr = pts[pts.length - 1];
          ctx.save();
          ctx.lineCap = 'round';
          ctx.lineJoin = 'round';
          if ((bs.flow ?? 1.0) < 0.999) {
            ctx.globalAlpha = Math.max(0.01, Math.min(1.0, bs.flow ?? 1.0));
          }
          if (isBgEraser) {
            ctx.globalCompositeOperation = 'source-over';
            ctx.strokeStyle = '#ffffff';
          } else if (isEraser) {
            ctx.globalCompositeOperation = 'destination-out';
            ctx.strokeStyle = 'rgba(0, 0, 0, 1)';
          } else {
            ctx.globalCompositeOperation = 'source-over';
            ctx.strokeStyle = strokeColor;
          }
          ctx.lineWidth = (pPrev.width + pCurr.width) / 2;
          ctx.beginPath();
          ctx.moveTo(pPrev.x, pPrev.y);
          ctx.lineTo(pCurr.x, pCurr.y);
          ctx.stroke();
          ctx.restore();
        }
      }
    }
  }, [colorMode]);

  const layersRef = useRef(layers);
  useEffect(() => {
    layersRef.current = layers;
  }, [layers]);

  const handleRemoteStrokeFinish = useCallback((msg: StrokeFinishMessage) => {
    const strokeState = remoteStrokeStatesRef.current.get(msg.strokeId);
    if (!strokeState) return;

    if (msg.endPoint) {
      strokeState.points.push(msg.endPoint);
    }

    // Resolve target layer canvas with robust fallback so remote strokes never disappear
    let targetCanvas = layerCanvasesRef.current.get(msg.layerId);
    let targetLayerId = msg.layerId;

    if (!targetCanvas) {
      // 1. Try finding by peer id in layer id
      const byPeerId = layersRef.current.find(
        (l) => l.type === 'raster' && l.id.includes(String(msg.peerId))
      );
      if (byPeerId) {
        targetCanvas = layerCanvasesRef.current.get(byPeerId.id);
        targetLayerId = byPeerId.id;
      }
    }

    if (!targetCanvas) {
      // 2. Fallback to active layer or top raster layer
      const fallback =
        layersRef.current.find(
          (l) => l.type === 'raster' && l.id !== 'layer-bg' && !l.id.startsWith('layer-bg')
        ) || layersRef.current.find((l) => l.type === 'raster');
      if (fallback) {
        targetCanvas = layerCanvasesRef.current.get(fallback.id);
        targetLayerId = fallback.id;
      }
    }

    if (targetCanvas && strokeState.points.length > 0) {
      const targetLayer = layersRef.current.find((l) => l.id === targetLayerId);
      const isMono = colorMode === 'monochrome' || targetLayer?.expressionColor === 'monochrome';
      const targetFormat = isMono ? 'monochrome-1bit' : 'color-32bit';

      if (msg.vectorStroke && targetLayer?.type === 'vector') {
        targetLayer.vectorStrokes = [...(targetLayer.vectorStrokes || []), msg.vectorStroke];
        const ctx = get2DContext(targetCanvas);
        if (ctx) {
          renderVectorStroke(ctx, msg.vectorStroke);
          const fullData = ctx.getImageData(0, 0, targetCanvas.width, targetCanvas.height);
          globalTileGrid.writeImageData(targetLayerId, fullData, 0, 0, targetFormat);
        }
        globalTileGrid.notifyChange(true);
        updateLayerThumbnail(targetLayerId, true);
      } else {
        const ctx = get2DContext(targetCanvas);
        if (ctx) {
          const isEraser = strokeState.tool === 'eraser';
          const isBgEraser = isEraser && (targetLayerId === 'layer-bg' || targetLayerId.startsWith('layer-bg'));
          const bs = strokeState.brushSettings;
          const isTranslucentBrush = !isEraser && (bs.opacity ?? 1.0) < 0.999;
          const isAlphaLocked = Boolean(targetLayer?.alphaLocked);
          const isTransparentInk = Boolean(bs.isTransparentInk);

          if (isTranslucentBrush || isTransparentInk || isAlphaLocked) {
            const bakeCanvas = getReusableBakeCanvas(targetCanvas.width, targetCanvas.height);
            const bCtx = get2DContext(bakeCanvas);
            if (bCtx) {
              bCtx.clearRect(0, 0, targetCanvas.width, targetCanvas.height);
              renderCompleteStroke(
                bCtx,
                strokeState.points,
                { ...bs, opacity: 1.0, isTransparentInk: false },
                strokeState.tool,
                colorMode,
                isBgEraser,
                targetCanvas,
                false
              );
              ctx.save();
              ctx.globalAlpha = Math.max(0.01, Math.min(1.0, bs.opacity ?? 1.0));
              if (isTransparentInk) {
                ctx.globalCompositeOperation = 'destination-out';
              } else if (isAlphaLocked) {
                ctx.globalCompositeOperation = 'source-atop';
              } else {
                ctx.globalCompositeOperation = 'source-over';
              }
              ctx.drawImage(bakeCanvas, 0, 0);
              ctx.restore();
            }
          } else {
            renderCompleteStroke(
              ctx,
              strokeState.points,
              bs,
              strokeState.tool,
              colorMode,
              isBgEraser,
              targetCanvas,
              isAlphaLocked
            );
          }

          const pad = Math.ceil(Math.max(32, (bs.size || 10) * 1.5));
          let dirtyX = 0;
          let dirtyY = 0;
          let dirtyW = targetCanvas.width;
          let dirtyH = targetCanvas.height;

          if (msg.dirtyRect) {
            dirtyX = Math.max(0, Math.floor(msg.dirtyRect.x));
            dirtyY = Math.max(0, Math.floor(msg.dirtyRect.y));
            dirtyW = Math.min(targetCanvas.width - dirtyX, Math.ceil(msg.dirtyRect.width));
            dirtyH = Math.min(targetCanvas.height - dirtyY, Math.ceil(msg.dirtyRect.height));
          } else if (strokeState.points.length > 0) {
            let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
            for (const pt of strokeState.points) {
              if (pt.x < minX) minX = pt.x;
              if (pt.y < minY) minY = pt.y;
              if (pt.x > maxX) maxX = pt.x;
              if (pt.y > maxY) maxY = pt.y;
            }
            dirtyX = Math.max(0, Math.floor(minX - pad));
            dirtyY = Math.max(0, Math.floor(minY - pad));
            dirtyW = Math.min(targetCanvas.width - dirtyX, Math.ceil(maxX + pad) - dirtyX);
            dirtyH = Math.min(targetCanvas.height - dirtyY, Math.ceil(maxY + pad) - dirtyY);
          }

          if (dirtyW > 0 && dirtyH > 0) {
            const afterData = ctx.getImageData(dirtyX, dirtyY, dirtyW, dirtyH);
            globalTileGrid.writeImageData(targetLayerId, afterData, dirtyX, dirtyY, targetFormat);
          }

          globalTileGrid.notifyChange(true);
          updateLayerThumbnail(targetLayerId, true);
        }
      }
    }

    // Clear remote draft canvas
    const draftCanvas = remoteDraftCanvasesRef.current.get(msg.peerId);
    if (draftCanvas) {
      const ctx = get2DContext(draftCanvas);
      if (ctx) {
        ctx.clearRect(0, 0, draftCanvas.width, draftCanvas.height);
      }
    }

    remoteStrokeStatesRef.current.delete(msg.strokeId);
  }, [colorMode, layerCanvasesRef, updateLayerThumbnail]);

  const handleRemoteDocSync = useCallback((
    syncDims: CanvasDimensions,
    syncMode: CanvasColorMode,
    syncLayers: LayerItem[],
    syncDataUrls: Record<string, string>
  ) => {
    setDimensions(syncDims);
    setColorMode(syncMode);
    syncRemoteDocument(syncLayers, syncDataUrls);
    const newDocId = `doc-collab-${Date.now()}`;
    const newDoc: DocumentTab = {
      id: newDocId,
      name: 'Collab Session',
      dimensions: syncDims,
      colorMode: syncMode,
      layers: syncLayers,
      activeLayerId: syncLayers[0]?.id || 'layer-1',
      perspectiveRuler: null,
    };
    setPerspectiveRuler(null);
    setDocuments([newDoc]);
    setActiveDocumentId(newDocId);
    setDocumentName('Collab Session');
  }, [syncRemoteDocument]);

  const handleRemoteAssignedLayer = useCallback((layerId: string) => {
    setActiveLayerId(layerId);
  }, [setActiveLayerId]);

  const handleRemoteJoinRequest = useCallback((peer: import('./types/multiplayer').CollabPeer) => {
    // Automatically allocate a dedicated layer for the joining peer without hijacking host's active layer
    const layerName = getNextCollabLayerName(peer.name, layersRef.current);
    const layerId = `layer-${peer.id}-1`;
    const newLayer = addLayer('raster', null, layerName, layerId, false);
    multiplayerService.sendLayerAdd(newLayer);
    const updated = layersRef.current.some((l) => l.id === newLayer.id)
      ? layersRef.current
      : [newLayer, ...layersRef.current];
    return {
      assignedLayerId: layerId,
      updatedLayers: updated,
    };
  }, [addLayer]);

  const handleRemoteLayerAction = useCallback((msg: MultiplayerMessage) => {
    if (msg.type === 'LAYER_ADD') {
      const layerItem = (msg as any).layerItem as LayerItem;
      const imageDataUrl = (msg as any).imageDataUrl as string | undefined;
      if (layerItem) {
        addRemoteLayer(layerItem, imageDataUrl);
      }
    } else if (msg.type === 'LAYER_DELETE') {
      const layerId = (msg as any).layerId;
      if (layerId) {
        deleteRemoteLayer(layerId);
      }
    } else if (msg.type === 'LAYER_CLEAR') {
      const layerId = (msg as any).layerId;
      const targetCanvas = layerCanvasesRef.current.get(layerId);
      if (targetCanvas) {
        const ctx = get2DContext(targetCanvas);
        if (ctx) {
          const isBg = layerId === 'layer-bg' || layerId.startsWith('layer-bg');
          if (isBg) {
            ctx.fillStyle = '#ffffff';
            ctx.fillRect(0, 0, targetCanvas.width, targetCanvas.height);
            globalTileGrid.ingestCanvas(layerId, targetCanvas, 'color-32bit');
          } else {
            ctx.clearRect(0, 0, targetCanvas.width, targetCanvas.height);
            globalTileGrid.clearLayer(layerId);
          }
          globalTileGrid.notifyChange(true);
          updateLayerThumbnail(layerId, true);
        }
      }
    } else if (msg.type === 'LAYER_RENAME') {
      const layerId = (msg as any).layerId;
      const newName = (msg as any).newName;
      if (layerId && newName) {
        renameLayer(layerId, newName);
      }
    } else if (msg.type === 'LAYER_VISIBILITY') {
      const layerId = (msg as any).layerId;
      const visible = (msg as any).visible;
      if (layerId && visible !== undefined) {
        const l = layersRef.current.find((item) => item.id === layerId);
        if (l && l.visible !== visible) {
          toggleVisibility(layerId);
        }
      }
    } else if (msg.type === 'LAYER_OPACITY') {
      const layerId = (msg as any).layerId;
      const opacity = (msg as any).opacity;
      if (layerId && opacity !== undefined) {
        setOpacity(layerId, opacity);
      }
    }
  }, [addRemoteLayer, deleteRemoteLayer, layerCanvasesRef, updateLayerThumbnail, renameLayer, toggleVisibility, setOpacity]);

  const selectiveUndoRef = useRef<(peerId?: string | number) => void>(() => {});

  const {
    isConnected: isCollabConnected,
    isHost: isCollabHost,
    hostInfo: collabHostInfo,
    peers: collabPeers,
    myPeer: collabMyPeer,
    activePings: collabActivePings,
    clipboardInvite,
    setClipboardInvite,
    webLandingInvite,
    setWebLandingInvite,
    isHostModalOpen,
    setIsHostModalOpen,
    startHosting,
    stopHosting,
    joinRoom,
    leaveRoom: _leaveRoom,
    updateMyName,
    sendPing: _sendPing,
  } = useMultiplayer({
    dimensions,
    colorMode,
    layers,
    layerCanvasesRef,
    onRemoteStrokeStart: handleRemoteStrokeStart,
    onRemoteStrokeChunk: handleRemoteStrokeChunk,
    onRemoteStrokeFinish: handleRemoteStrokeFinish,
    onRemoteDocSync: handleRemoteDocSync,
    onRemoteJoinRequest: handleRemoteJoinRequest,
    onRemoteAssignedLayer: handleRemoteAssignedLayer,
    onRemoteLayerAction: handleRemoteLayerAction,
    onRemoteSelectiveUndo: (_strokeId, peerId) => {
      selectiveUndoRef.current(peerId);
    },
    showToast,
  });

  // When hosting starts, ensure host's primary drawing layer has the host's nickname
  const handleStartHosting = useCallback(
    async (roomName: string, port: number, hostNickname?: string, isGlobal?: boolean) => {
      if (!hasOpenDocument) {
        showToast('Please create or open a canvas before hosting a session.');
        return false;
      }
      const finalHostName = (hostNickname || collabMyPeer.name || 'Sora').trim();
      const defaultLayer =
        layersRef.current.find((l) => l.id === activeLayerId) ||
        layersRef.current.find((l) => l.type === 'raster' && l.id !== 'layer-bg' && !l.id.startsWith('layer-bg'));
      if (
        defaultLayer &&
        (defaultLayer.name === 'Layer 1' ||
          !defaultLayer.name.toLowerCase().startsWith(finalHostName.toLowerCase()))
      ) {
        const hostLayerName = getNextCollabLayerName(
          finalHostName,
          layersRef.current.filter((l) => l.id !== defaultLayer.id)
        );
        renameLayer(defaultLayer.id, hostLayerName);
      }
      return await startHosting(roomName, port, finalHostName, isGlobal);
    },
    [hasOpenDocument, showToast, collabMyPeer.name, activeLayerId, renameLayer, startHosting]
  );

  // Collaborative-aware Layer Operations
  const handleAddLayer = useCallback(
    (type: 'raster' | 'folder' = 'raster') => {
      if (isCollabConnected && type === 'raster') {
        const name = getNextCollabLayerName(collabMyPeer.name, layersRef.current);
        const newLayer = addLayer('raster', null, name);
        if (newLayer) {
          multiplayerService.sendLayerAdd(newLayer);
        }
      } else {
        addLayer(type);
      }
    },
    [isCollabConnected, collabMyPeer.name, addLayer]
  );

  const handleDeleteLayer = useCallback(
    (id: string) => {
      deleteLayer(id);
      if (isCollabConnected) {
        multiplayerService.sendLayerDelete(id);
      }
    },
    [deleteLayer, isCollabConnected]
  );

  const handleDeleteSelectedLayers = useCallback(() => {
    if (selectedLayerIds && selectedLayerIds.length > 1) {
      deleteSelectedLayers();
      showToast(`Deleted ${selectedLayerIds.length} layers`);
    } else {
      handleDeleteLayer(activeLayerId);
    }
  }, [selectedLayerIds, deleteSelectedLayers, handleDeleteLayer, activeLayerId, showToast]);

  const handleGroupSelectedLayers = useCallback(() => {
    groupSelectedLayers();
    showToast('Grouped layers into folder');
  }, [groupSelectedLayers, showToast]);

  const handleToggleVisibility = useCallback(
    (id: string) => {
      const l = layersRef.current.find((item) => item.id === id);
      toggleVisibility(id);
      if (isCollabConnected && l) {
        multiplayerService.sendLayerVisibility(id, !l.visible);
      }
    },
    [toggleVisibility, isCollabConnected]
  );

  const handleSetOpacity = useCallback(
    (id: string, opacity: number) => {
      setOpacity(id, opacity);
      if (isCollabConnected) {
        multiplayerService.sendLayerOpacity(id, opacity);
      }
    },
    [setOpacity, isCollabConnected]
  );

  const handleRenameLayer = useCallback(
    (id: string, newName: string) => {
      renameLayer(id, newName);
      if (isCollabConnected) {
        multiplayerService.sendLayerRename(id, newName);
      }
    },
    [renameLayer, isCollabConnected]
  );

  const handleClearActiveLayer = useCallback(() => {
    clearActiveLayer();
    if (isCollabConnected) {
      multiplayerService.sendLayerClear(activeLayerId);
    }
  }, [clearActiveLayer, isCollabConnected, activeLayerId]);

  const {
    interactionRef,
    isDrawingRef,
    getActiveCanvas,
    pushHistoryStep,
    handlePointerDown: handleCanvasDrawingPointerDown,
    handlePointerMove: handleCanvasDrawingPointerMove,
    handlePointerUp: handleCanvasDrawingPointerUp,
    handlePointerEnter,
    handlePointerLeave,
    undo,
    redo,
    canUndo,
    canRedo,
    historyList,
    historyIndex,
    jumpToHistoryIndex,
    clearCanvas,
    resetHistory,
    selectiveUndo,
    cursorPos,
    isHovering,
  } = useCanvasDrawing({
    tool,
    brushSettings,
    dimensions,
    colorMode,
    disabled: !hasOpenDocument || isSpaceDown || isPanning || isRotating,
    viewportRef,
    pan,
    zoom,
    rotation,
    activeLayerId,
    activeSessionId: activeDocumentId,
    activeLayerLocked: activeLayer?.locked ?? false,
    activeLayerVisible: activeLayer ? isLayerEffectivelyVisible(activeLayer) : true,
    layerCanvasesRef,
    layerSourceCanvasesRef,
    layers: hasOpenDocument ? layers : [],
    onUpdateLayerThumbnail: updateLayerThumbnail,
    isMaskMode: activeEditTarget === 'mask',
    onUpdateMaskThumbnail: updateMaskThumbnail,
    draftCanvasRef,
    strokeCanvasRef,
    onCollabStrokeStart: (strokeId, layerId, bs, t, startPt) => {
      if (multiplayerService.isConnected()) {
        multiplayerService.sendStrokeStart(strokeId, layerId, bs, t, startPt);
      }
    },
    onCollabStrokeChunk: (strokeId, pts) => {
      if (multiplayerService.isConnected()) {
        multiplayerService.sendStrokeChunk(strokeId, pts);
      }
    },
    onCollabStrokeFinish: (strokeId, layerId, endPt, dirty, vectorStroke) => {
      if (multiplayerService.isConnected()) {
        multiplayerService.sendStrokeFinish(strokeId, layerId, endPt, dirty, vectorStroke);
      }
    },
    onCollabCursorMove: (x, y, isDrawing, t) => {
      if (multiplayerService.isConnected()) {
        multiplayerService.sendCursor(x, y, isDrawing, t);
      }
    },
    perspectiveRuler: hasOpenDocument ? perspectiveRuler : null,
    onActiveConstraintAxisChange: handleActiveConstraintAxisChange,
    selection: hasOpenDocument ? selection : null,
  });

  selectiveUndoRef.current = selectiveUndo;
  pushHistoryStepRef.current = pushHistoryStep;

  const handleUndo = useCallback(() => {
    if (isCollabConnected && collabMyPeer.id) {
      selectiveUndo(collabMyPeer.id);
      multiplayerService.sendSelectiveUndo(collabMyPeer.id.toString());
    } else {
      undo();
    }
  }, [isCollabConnected, collabMyPeer.id, selectiveUndo, undo]);


  const handleSelectTool = useCallback((newTool: ToolType) => {
    const prevTool = toolRef.current;
    if (prevTool === newTool) return;

    if (newTool === 'eraser') {
      const eraserSettings = getEffectiveBrushSettings(ERASER_PRESET_ID);
      setBrushSettings((prev) => ({
        ...prev,
        ...eraserSettings,
        color: prev.color,
      }));
    } else if (prevTool === 'eraser' && newTool === 'brush') {
      const activePreset = brushSettings.preset || getActivePresetId();
      const brushCfg = getEffectiveBrushSettings(activePreset);
      setBrushSettings((prev) => ({
        ...prev,
        ...brushCfg,
        color: prev.color,
      }));
    }

    setTool(newTool);
  }, [brushSettings.preset]);

  const updateBrushSettings = useCallback((newSettings: Partial<BrushSettings>) => {
    setBrushSettings((prev) => {
      const next = { ...prev, ...newSettings };
      const targetPresetId = toolRef.current === 'eraser'
        ? ERASER_PRESET_ID
        : (next.preset || prev.preset || DEFAULT_BRUSH_PRESET_ID);

      saveBrushSettingsDebounced(targetPresetId, next);
      if (next.preset && toolRef.current === 'brush') {
        saveActivePresetId(next.preset);
      }
      return next;
    });
  }, []);

  useEffect(() => {
    const handleBeforeUnload = () => flushPendingBrushSettingsSave();
    window.addEventListener('beforeunload', handleBeforeUnload);
    return () => {
      flushPendingBrushSettingsSave();
      window.removeEventListener('beforeunload', handleBeforeUnload);
    };
  }, []);


  const addRecentColor = useCallback((color: string) => {
    setRecentColors((prev) => {
      const filtered = prev.filter((c) => c.toLowerCase() !== color.toLowerCase());
      return [color, ...filtered].slice(0, 14);
    });
  }, []);

  const [isTransparentColor, setIsTransparentColor] = useState<boolean>(false);

  const toggleTransparentColor = useCallback(() => {
    setIsTransparentColor((prev) => {
      const next = !prev;
      updateBrushSettings({ isTransparentInk: next });
      showToast(next ? 'Transparent ink mode active' : 'Color ink mode active');
      return next;
    });
  }, [updateBrushSettings, showToast]);

  const handlePrimaryColorChange = useCallback(
    (color: string, commit = true) => {
      const effective = enforceColorMode(color, colorMode);
      setPrimaryColor(effective);
      setIsTransparentColor(false);
      updateBrushSettings({ color: effective, isTransparentInk: false });
      if (commit) {
        addRecentColor(effective);
      }
      if (toolRef.current === 'eraser') {
        handleSelectTool('brush');
      }
    },
    [addRecentColor, colorMode, handleSelectTool, updateBrushSettings]
  );

  const handleSecondaryColorChange = useCallback(
    (color: string, commit = true) => {
      const effective = enforceColorMode(color, colorMode);
      setSecondaryColor(effective);
      updateBrushSettings({ secondaryColor: effective });
      if (commit) {
        addRecentColor(effective);
      }
    },
    [addRecentColor, colorMode, updateBrushSettings]
  );

  const handleSwapColors = useCallback(() => {
    setIsTransparentColor(false);
    setPrimaryColor((prevPrim) => {
      setSecondaryColor(prevPrim);
      const effective = enforceColorMode(secondaryColor, colorMode);
      updateBrushSettings({ color: effective, secondaryColor: prevPrim, isTransparentInk: false });
      addRecentColor(effective);
      return effective;
    });
    if (toolRef.current === 'eraser') {
      handleSelectTool('brush');
    }
  }, [addRecentColor, colorMode, handleSelectTool, secondaryColor, updateBrushSettings]);

  const getCanvasCoords = useCallback(
    (e: React.PointerEvent<HTMLElement> | PointerEvent) => {
      if (!viewportRef.current) return { x: 0, y: 0 };
      const vRect = viewportRef.current.getBoundingClientRect();
      return screenToCanvas(e.clientX, e.clientY, vRect, pan, zoom, rotation, dimensions);
    },
    [viewportRef, pan, zoom, rotation, dimensions]
  );

  const handleSampleColor = useCallback(
    (pt: { x: number; y: number }) => {
      const sampled = sampleCompositedColor(
        layers,
        layerCanvasesRef.current,
        pt.x,
        pt.y,
        isLayerEffectivelyVisible,
        getEffectiveOpacity,
        dimensions.width,
        dimensions.height,
        selection?.floating
      );
      if (sampled) {
        handlePrimaryColorChange(sampled, true);
      }
    },
    [
      layers,
      layerCanvasesRef,
      isLayerEffectivelyVisible,
      getEffectiveOpacity,
      dimensions.width,
      dimensions.height,
      selection?.floating,
      handlePrimaryColorChange,
    ]
  );

  const handleCommitFloatingSelection = useCallback(() => {
    if (!selection?.floating) return;
    const targetLayerId = selection.floating.layerId || activeLayerId;
    const canvas = layerCanvasesRef.current.get(targetLayerId) || getActiveCanvas();
    if (!canvas) return;

    const sourceCanvas = layerSourceCanvasesRef.current?.get(targetLayerId);
    commitFloatingSelection(canvas, selection.floating, sourceCanvas);

    const ctx = get2DContext(canvas);
    if (ctx) {
      const afterData = ctx.getImageData(0, 0, canvas.width, canvas.height);
      if (selection.floating.beforeImageData) {
        pushHistoryStep(
          'selection-move',
          'Move Selection',
          selection.floating.beforeImageData,
          afterData,
          targetLayerId
        );
      } else {
        const lyr = layers.find((l) => l.id === targetLayerId);
        const isMono = colorMode === 'monochrome' || lyr?.expressionColor === 'monochrome';
        globalTileGrid.writeImageData(targetLayerId, afterData, 0, 0, isMono ? 'monochrome-1bit' : 'color-32bit');
      }
      globalTileGrid.notifyChange(true);
    }

    updateLayerThumbnail(targetLayerId, true);
    setSelection((prev) => (prev ? { ...prev, floating: null } : null));
  }, [selection, activeLayerId, layers, colorMode, layerCanvasesRef, getActiveCanvas, layerSourceCanvasesRef, pushHistoryStep, updateLayerThumbnail]);

  const handleDeselect = useCallback(() => {
    if (selection?.floating) {
      handleCommitFloatingSelection();
    }
    setSelection(null);
  }, [selection, handleCommitFloatingSelection]);

  const handleClearSelection = useCallback(() => {
    if (!selection) return;
    if (selection.floating) {
      const targetLayerId = selection.floating.layerId || activeLayerId;
      const canvas = layerCanvasesRef.current.get(targetLayerId) || getActiveCanvas();
      if (canvas && selection.floating.beforeImageData) {
        const ctx = get2DContext(canvas);
        if (ctx) {
          const afterData = ctx.getImageData(0, 0, canvas.width, canvas.height);
          pushHistoryStep(
            'clear',
            'Clear Selection',
            selection.floating.beforeImageData,
            afterData,
            targetLayerId
          );
          globalTileGrid.notifyChange(true);
        }
      }
      setSelection(null);
      return;
    }

    const canvas = getActiveCanvas();
    if (!canvas) return;
    const ctx = get2DContext(canvas);
    if (!ctx) return;

    const beforeImageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const sourceCanvas = layerSourceCanvasesRef.current?.get(activeLayerId);
    const isBg = activeLayerId === 'layer-bg' || activeLayerId.startsWith('layer-bg');

    const clearOn = (target: HTMLCanvasElement) => {
      const c = get2DContext(target);
      if (!c) return;
      c.save();
      if (selection.mask && selection.maskWidth && selection.maskHeight) {
        const maskCanvas = document.createElement('canvas');
        maskCanvas.width = target.width;
        maskCanvas.height = target.height;
        const mCtx = maskCanvas.getContext('2d');
        if (mCtx) {
          const mImg = mCtx.createImageData(target.width, target.height);
          for (let i = 0; i < selection.mask.length; i++) {
            if (isBg) {
              mImg.data[i * 4] = 255;
              mImg.data[i * 4 + 1] = 255;
              mImg.data[i * 4 + 2] = 255;
            }
            mImg.data[i * 4 + 3] = selection.mask[i];
          }
          mCtx.putImageData(mImg, 0, 0);
          c.globalCompositeOperation = isBg ? 'source-over' : 'destination-out';
          c.drawImage(maskCanvas, 0, 0);
        }
      } else if (selection.type === 'rect') {
        if (isBg) {
          c.fillStyle = '#ffffff';
          c.fillRect(selection.bounds.x, selection.bounds.y, selection.bounds.width, selection.bounds.height);
        } else {
          c.clearRect(selection.bounds.x, selection.bounds.y, selection.bounds.width, selection.bounds.height);
        }
      } else if (selection.type === 'lasso' && selection.polygon && selection.polygon.length >= 3) {
        c.beginPath();
        c.moveTo(selection.polygon[0].x, selection.polygon[0].y);
        for (let i = 1; i < selection.polygon.length; i++) {
          c.lineTo(selection.polygon[i].x, selection.polygon[i].y);
        }
        c.closePath();
        if (isBg) {
          c.fillStyle = '#ffffff';
          c.fill();
        } else {
          c.globalCompositeOperation = 'destination-out';
          c.fillStyle = 'rgba(0, 0, 0, 1)';
          c.fill();
        }
      }
      c.restore();
    };

    clearOn(canvas);
    if (sourceCanvas) clearOn(sourceCanvas);

    const afterImageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
    updateLayerThumbnail(activeLayerId, true);
    pushHistoryStep(
      'clear',
      'Clear Selection',
      beforeImageData,
      afterImageData,
      activeLayerId
    );
    globalTileGrid.notifyChange(true);
  }, [selection, getActiveCanvas, activeLayerId, layerCanvasesRef, layerSourceCanvasesRef, updateLayerThumbnail, pushHistoryStep]);

  const handleFillSelectionColor = useCallback(() => {
    if (!selection) return;
    const canvas = getActiveCanvas();
    if (!canvas) return;
    const ctx = get2DContext(canvas);
    if (!ctx) return;

    const beforeImageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const sourceCanvas = layerSourceCanvasesRef.current?.get(activeLayerId);

    const fillOn = (target: HTMLCanvasElement) => {
      const c = get2DContext(target);
      if (!c) return;
      c.save();
      if (selection.mask && selection.maskWidth && selection.maskHeight) {
        const maskCanvas = document.createElement('canvas');
        maskCanvas.width = target.width;
        maskCanvas.height = target.height;
        const mCtx = maskCanvas.getContext('2d');
        if (mCtx) {
          mCtx.fillStyle = primaryColor;
          mCtx.fillRect(0, 0, target.width, target.height);
          const mImg = mCtx.getImageData(0, 0, target.width, target.height);
          for (let i = 0; i < selection.mask.length; i++) {
            mImg.data[i * 4 + 3] = Math.round((mImg.data[i * 4 + 3] * selection.mask[i]) / 255);
          }
          mCtx.putImageData(mImg, 0, 0);
          c.drawImage(maskCanvas, 0, 0);
        }
      } else {
        c.fillStyle = primaryColor;
        if (selection.type === 'rect') {
          c.fillRect(selection.bounds.x, selection.bounds.y, selection.bounds.width, selection.bounds.height);
        } else if (selection.type === 'lasso' && selection.polygon && selection.polygon.length >= 3) {
          c.beginPath();
          c.moveTo(selection.polygon[0].x, selection.polygon[0].y);
          for (let i = 1; i < selection.polygon.length; i++) {
            c.lineTo(selection.polygon[i].x, selection.polygon[i].y);
          }
          c.closePath();
          c.fill();
        }
      }
      c.restore();
    };

    fillOn(canvas);
    if (sourceCanvas) {
      fillOn(sourceCanvas);
      if (activeLayer?.toneEnabled) {
        applyLayerEffects(sourceCanvas, canvas, activeLayer, dimensions.dpi ?? 600, selection.bounds);
      }
    }

    const afterImageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
    updateLayerThumbnail(activeLayerId, true);
    pushHistoryStep(
      'fill',
      'Fill Selection',
      beforeImageData,
      afterImageData,
      activeLayerId
    );
  }, [selection, getActiveCanvas, primaryColor, activeLayerId, activeLayer, layerSourceCanvasesRef, dimensions.dpi, updateLayerThumbnail, pushHistoryStep]);

  const handleExpandSelection = useCallback(
    (pixels = 5) => {
      if (!selection) return;
      const w = dimensions.width;
      const h = dimensions.height;
      const currentMask = selectionToMask(selection, w, h);
      const expanded = expandSelection(currentMask, w, h, pixels);
      const b = maskToBounds(expanded, w, h);
      if (!b) {
        setSelection(null);
        return;
      }
      const svg = maskToSvgPath(expanded, w, h);
      setSelection({
        type: 'mask',
        bounds: b,
        mask: expanded,
        maskWidth: w,
        maskHeight: h,
        svgPath: svg,
      });
      showToast(`Expanded Selection (+${pixels}px)`);
    },
    [selection, dimensions, showToast]
  );

  const handleContractSelection = useCallback(
    (pixels = 5) => {
      if (!selection) return;
      const w = dimensions.width;
      const h = dimensions.height;
      const currentMask = selectionToMask(selection, w, h);
      const contracted = contractSelection(currentMask, w, h, pixels);
      const b = maskToBounds(contracted, w, h);
      if (!b) {
        setSelection(null);
        showToast('Selection contracted to empty');
        return;
      }
      const svg = maskToSvgPath(contracted, w, h);
      setSelection({
        type: 'mask',
        bounds: b,
        mask: contracted,
        maskWidth: w,
        maskHeight: h,
        svgPath: svg,
      });
      showToast(`Contracted Selection (-${pixels}px)`);
    },
    [selection, dimensions, showToast]
  );

  const handleFeatherSelection = useCallback(
    (radius = 5) => {
      if (!selection) return;
      const w = dimensions.width;
      const h = dimensions.height;
      const currentMask = selectionToMask(selection, w, h);
      const feathered = featherSelection(currentMask, w, h, radius);
      const b = maskToBounds(feathered, w, h);
      if (!b) {
        setSelection(null);
        return;
      }
      const svg = maskToSvgPath(feathered, w, h);
      setSelection({
        type: 'mask',
        bounds: b,
        mask: feathered,
        maskWidth: w,
        maskHeight: h,
        svgPath: svg,
      });
      showToast(`Feathered Selection (${radius}px)`);
    },
    [selection, dimensions, showToast]
  );

  const handleInvertSelection = useCallback(() => {
    const w = dimensions.width;
    const h = dimensions.height;
    const currentMask = selection ? selectionToMask(selection, w, h) : new Uint8Array(w * h);
    const inverted = invertSelection(currentMask, w, h);
    const b = maskToBounds(inverted, w, h);
    if (!b) {
      setSelection(null);
      showToast('Inverted Selection (Empty)');
      return;
    }
    const svg = maskToSvgPath(inverted, w, h);
    setSelection({
      type: 'mask',
      bounds: b,
      mask: inverted,
      maskWidth: w,
      maskHeight: h,
      svgPath: svg,
    });
    showToast('Inverted Selection');
  }, [selection, dimensions, showToast]);

  const handleSelectAll = useCallback(() => {
    const w = dimensions.width;
    const h = dimensions.height;
    const mask = new Uint8Array(w * h);
    mask.fill(255);
    const svg = `M 0 0 H ${w} V ${h} H 0 Z`;
    setSelection({
      type: 'rect',
      bounds: { x: 0, y: 0, width: w, height: h },
      mask,
      maskWidth: w,
      maskHeight: h,
      svgPath: svg,
    });
    showToast('Selected All (Ctrl+A)');
  }, [dimensions, showToast]);

  const handleToggleReferenceLayer = useCallback((layerId: string) => {
    setLayers((prev) =>
      prev.map((l) => (l.id === layerId ? { ...l, isReference: !l.isReference } : l))
    );
  }, [setLayers]);

  const getTonalLabel = useCallback((type: TonalCorrectionType) => {
    switch (type) {
      case 'brightness-contrast':
        return 'Brightness/Contrast';
      case 'binarization':
        return 'Binarization';
      case 'hue-saturation':
        return 'Hue/Saturation/Luminosity';
      case 'posterization':
        return 'Posterization';
      case 'level-correction':
        return 'Level Correction';
      case 'reverse-gradient':
        return 'Reverse Gradient';
      default:
        return 'Tonal Correction';
    }
  }, []);

  const handleOpenTonalModal = useCallback(
    (type: TonalCorrectionType) => {
      if (!hasOpenDocument || !activeLayer || activeLayer.locked || activeLayer.type !== 'raster') return;
      if (selection?.floating) {
        handleCommitFloatingSelection();
      }

      let targetLayerId = activeLayerId;
      let targetLayer = layers.find((l) => l.id === targetLayerId);
      let displayCanvas = layerCanvasesRef.current.get(targetLayerId);

      // Verify if target layer has pixels, or if user is accidentally on an empty layer
      let hasPixels = false;
      if (displayCanvas) {
        const dCtx = get2DContext(displayCanvas);
        if (dCtx) {
          const dData = dCtx.getImageData(0, 0, displayCanvas.width, displayCanvas.height).data;
          for (let i = 3; i < dData.length; i += 4) {
            if (dData[i] > 0) {
              hasPixels = true;
              break;
            }
          }
        }
      }

      // If active layer is completely empty, check if another visible raster layer has artwork (e.g. image layer below)
      if (!hasPixels) {
        const candidate = layers.find((l) => {
          if (l.id === targetLayerId || l.type !== 'raster' || !l.visible) return false;
          const c = layerCanvasesRef.current.get(l.id);
          if (!c) return false;
          const cCtx = get2DContext(c);
          if (!cCtx) return false;
          const cData = cCtx.getImageData(0, 0, c.width, c.height).data;
          for (let j = 3; j < cData.length; j += 4) {
            if (cData[j] > 0) return true;
          }
          return false;
        });

        if (candidate) {
          targetLayerId = candidate.id;
          targetLayer = candidate;
          displayCanvas = layerCanvasesRef.current.get(candidate.id);
          setActiveLayerId(candidate.id);
          showToast(`Switched to "${candidate.name}" (active layer had no pixels)`);
        } else {
          showToast('Selected layer is empty. Draw or open an image first.');
          return;
        }
      }

      const isTone = Boolean(targetLayer?.toneEnabled && layerSourceCanvasesRef.current?.get(targetLayerId));
      const sourceCanvas = layerSourceCanvasesRef.current?.get(targetLayerId);
      const canvas = (isTone && sourceCanvas) ? sourceCanvas : displayCanvas;

      if (!canvas) {
        showToast('Canvas not available for active layer.');
        return;
      }
      const ctx = get2DContext(canvas);
      if (!ctx) return;

      const beforeImageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
      const selectionMask = createSelectionMask(selection, canvas.width, canvas.height);
      const bounds = getProcessingBounds(selection, canvas.width, canvas.height);

      const newState = {
        isOpen: true,
        type,
        targetLayerId,
        beforeImageData,
        selectionMask,
        bounds,
      };
      tonalModalStateRef.current = newState;
      setTonalModalState(newState);
    },
    [
      hasOpenDocument,
      activeLayer,
      activeLayerId,
      layers,
      selection,
      handleCommitFloatingSelection,
      layerCanvasesRef,
      layerSourceCanvasesRef,
      setActiveLayerId,
      showToast,
    ]
  );

  const handleTonalPreviewChange = useCallback(
    (type: TonalCorrectionType, params: any, enabled: boolean) => {
      const state = tonalModalStateRef.current;
      if (!state.isOpen || !state.beforeImageData) return;
      const targetLayerId = state.targetLayerId;
      const targetLayer = layers.find((l) => l.id === targetLayerId);
      const isTone = Boolean(targetLayer?.toneEnabled && layerSourceCanvasesRef.current?.get(targetLayerId));
      const sourceCanvas = layerSourceCanvasesRef.current?.get(targetLayerId);
      const displayCanvas = layerCanvasesRef.current.get(targetLayerId);
      const canvas = (isTone && sourceCanvas) ? sourceCanvas : displayCanvas;
      if (!canvas) return;
      const ctx = get2DContext(canvas);
      if (!ctx) return;

      if (enabled) {
        const previewData = ctx.createImageData(canvas.width, canvas.height);
        applyTonalFilter(
          state.beforeImageData,
          previewData,
          type,
          params,
          state.selectionMask,
          state.bounds
        );
        ctx.putImageData(previewData, 0, 0);
      } else {
        ctx.putImageData(state.beforeImageData, 0, 0);
      }

      if (isTone && sourceCanvas && displayCanvas) {
        applyScreentone(sourceCanvas, displayCanvas, {
          frequency: targetLayer?.toneFrequency ?? 60,
          angle: targetLayer?.toneAngle ?? 45,
          dotShape: targetLayer?.toneDotShape ?? 'circle',
          dpi: dimensions.dpi ?? 600,
        });
      }

      if (displayCanvas) {
        const isMono = colorMode === 'monochrome' || targetLayer?.expressionColor === 'monochrome';
        globalTileGrid.ingestCanvas(targetLayerId, displayCanvas, isMono ? 'monochrome-1bit' : 'color-32bit');
        globalTileGrid.notifyChange(true);
      }
    },
    [layers, colorMode, layerCanvasesRef, layerSourceCanvasesRef, dimensions.dpi]
  );

  const handleTonalApply = useCallback(
    (type: TonalCorrectionType, params: any) => {
      const state = tonalModalStateRef.current;
      if (!state.isOpen || !state.beforeImageData) return;
      const targetLayerId = state.targetLayerId;
      const targetLayer = layers.find((l) => l.id === targetLayerId);
      const isTone = Boolean(targetLayer?.toneEnabled && layerSourceCanvasesRef.current?.get(targetLayerId));
      const sourceCanvas = layerSourceCanvasesRef.current?.get(targetLayerId);
      const displayCanvas = layerCanvasesRef.current.get(targetLayerId);
      const canvas = (isTone && sourceCanvas) ? sourceCanvas : displayCanvas;
      if (!canvas) return;
      const ctx = get2DContext(canvas);
      if (!ctx) return;

      const finalData = ctx.createImageData(canvas.width, canvas.height);
      applyTonalFilter(
        state.beforeImageData,
        finalData,
        type,
        params,
        state.selectionMask,
        state.bounds
      );
      ctx.putImageData(finalData, 0, 0);

      if (isTone && sourceCanvas && displayCanvas) {
        applyScreentone(sourceCanvas, displayCanvas, {
          frequency: targetLayer?.toneFrequency ?? 60,
          angle: targetLayer?.toneAngle ?? 45,
          dotShape: targetLayer?.toneDotShape ?? 'circle',
          dpi: dimensions.dpi ?? 600,
        });
      }

      updateLayerThumbnail(targetLayerId, true);
      const label = getTonalLabel(type);
      pushHistoryStep(
        'tonal-correction',
        label,
        state.beforeImageData,
        finalData,
        targetLayerId
      );
      globalTileGrid.notifyChange(true);

      const resetState = {
        isOpen: false,
        type,
        targetLayerId: '',
        beforeImageData: null,
        selectionMask: null,
        bounds: { x0: 0, y0: 0, x1: 0, y1: 0 },
      };
      tonalModalStateRef.current = resetState;
      setTonalModalState(resetState);
      showToast(`Applied ${label}`);
    },
    [
      layers,
      layerCanvasesRef,
      layerSourceCanvasesRef,
      dimensions.dpi,
      updateLayerThumbnail,
      getTonalLabel,
      pushHistoryStep,
      showToast,
    ]
  );

  const handleTonalCancel = useCallback(() => {
    const state = tonalModalStateRef.current;
    if (!state.isOpen) return;
    if (state.beforeImageData) {
      const targetLayerId = state.targetLayerId;
      const targetLayer = layers.find((l) => l.id === targetLayerId);
      const isTone = Boolean(targetLayer?.toneEnabled && layerSourceCanvasesRef.current?.get(targetLayerId));
      const sourceCanvas = layerSourceCanvasesRef.current?.get(targetLayerId);
      const displayCanvas = layerCanvasesRef.current.get(targetLayerId);
      const canvas = (isTone && sourceCanvas) ? sourceCanvas : displayCanvas;
      if (canvas) {
        const ctx = get2DContext(canvas);
        if (ctx) {
          ctx.putImageData(state.beforeImageData, 0, 0);
          if (isTone && sourceCanvas && displayCanvas) {
            applyScreentone(sourceCanvas, displayCanvas, {
              frequency: targetLayer?.toneFrequency ?? 60,
              angle: targetLayer?.toneAngle ?? 45,
              dotShape: targetLayer?.toneDotShape ?? 'circle',
              dpi: dimensions.dpi ?? 600,
            });
          }
          if (displayCanvas) {
            const isMono = colorMode === 'monochrome' || targetLayer?.expressionColor === 'monochrome';
            globalTileGrid.ingestCanvas(targetLayerId, displayCanvas, isMono ? 'monochrome-1bit' : 'color-32bit');
            globalTileGrid.notifyChange(true);
          }
        }
      }
    }

    const resetState = {
      isOpen: false,
      type: state.type,
      targetLayerId: '',
      beforeImageData: null,
      selectionMask: null,
      bounds: { x0: 0, y0: 0, x1: 0, y1: 0 },
    };
    tonalModalStateRef.current = resetState;
    setTonalModalState(resetState);
  }, [layers, colorMode, layerCanvasesRef, layerSourceCanvasesRef, dimensions.dpi]);

  const handleApplyReverseGradient = useCallback(() => {
    if (!hasOpenDocument || !activeLayer || activeLayer.locked || activeLayer.type !== 'raster') return;
    if (selection?.floating) {
      handleCommitFloatingSelection();
    }

    let targetLayerId = activeLayerId;
    let targetLayer = layers.find((l) => l.id === targetLayerId);
    let displayCanvas = layerCanvasesRef.current.get(targetLayerId);

    // Verify if target layer has pixels
    let hasPixels = false;
    if (displayCanvas) {
      const dCtx = get2DContext(displayCanvas);
      if (dCtx) {
        const dData = dCtx.getImageData(0, 0, displayCanvas.width, displayCanvas.height).data;
        for (let i = 3; i < dData.length; i += 4) {
          if (dData[i] > 0) {
            hasPixels = true;
            break;
          }
        }
      }
    }

    if (!hasPixels) {
      const candidate = layers.find((l) => {
        if (l.id === targetLayerId || l.type !== 'raster' || !l.visible) return false;
        const c = layerCanvasesRef.current.get(l.id);
        if (!c) return false;
        const cCtx = get2DContext(c);
        if (!cCtx) return false;
        const cData = cCtx.getImageData(0, 0, c.width, c.height).data;
        for (let j = 3; j < cData.length; j += 4) {
          if (cData[j] > 0) return true;
        }
        return false;
      });

      if (candidate) {
        targetLayerId = candidate.id;
        targetLayer = candidate;
        displayCanvas = layerCanvasesRef.current.get(candidate.id);
        setActiveLayerId(candidate.id);
        showToast(`Switched to "${candidate.name}" (active layer had no pixels)`);
      } else {
        showToast('Selected layer is empty. Draw or open an image first.');
        return;
      }
    }

    const isTone = Boolean(targetLayer?.toneEnabled && layerSourceCanvasesRef.current?.get(targetLayerId));
    const sourceCanvas = layerSourceCanvasesRef.current?.get(targetLayerId);
    const canvas = (isTone && sourceCanvas) ? sourceCanvas : displayCanvas;
    if (!canvas) return;
    const ctx = get2DContext(canvas);
    if (!ctx) return;

    const beforeImageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const afterImageData = ctx.createImageData(canvas.width, canvas.height);
    afterImageData.data.set(beforeImageData.data);

    const mask = createSelectionMask(selection, canvas.width, canvas.height);
    const bounds = getProcessingBounds(selection, canvas.width, canvas.height);

    applyReverseGradient(beforeImageData, afterImageData, mask, bounds);
    ctx.putImageData(afterImageData, 0, 0);

    if (isTone && sourceCanvas && displayCanvas) {
      applyScreentone(sourceCanvas, displayCanvas, {
        frequency: targetLayer?.toneFrequency ?? 60,
        angle: targetLayer?.toneAngle ?? 45,
        dotShape: targetLayer?.toneDotShape ?? 'circle',
        dpi: dimensions.dpi ?? 600,
      });
    }

    updateLayerThumbnail(targetLayerId, true);
    pushHistoryStep(
      'tonal-correction',
      'Reverse Gradient',
      beforeImageData,
      afterImageData,
      targetLayerId
    );
    showToast('Inverted colors (Reverse Gradient)');
  }, [
    hasOpenDocument,
    activeLayer,
    activeLayerId,
    layers,
    selection,
    handleCommitFloatingSelection,
    layerCanvasesRef,
    layerSourceCanvasesRef,
    dimensions.dpi,
    updateLayerThumbnail,
    pushHistoryStep,
    setActiveLayerId,
    showToast,
  ]);

  const handleStartTransform = useCallback(() => {
    if (transformSession?.active) return;
    const canvas = layerCanvasesRef.current.get(activeLayerId) || getActiveCanvas();
    if (!canvas) return;
    const ctx = get2DContext(canvas);
    if (!ctx) return;

    const isBg = activeLayerId === 'layer-bg' || activeLayerId.startsWith('layer-bg');

    if (selection) {
      let floatCanvas = selection.floating?.canvas;
      let floatX = selection.floating?.x ?? selection.bounds.x;
      let floatY = selection.floating?.y ?? selection.bounds.y;
      let beforeData = selection.floating?.beforeImageData;

      if (!floatCanvas) {
        const sourceCanvas = layerSourceCanvasesRef.current?.get(activeLayerId);
        const lifted = liftSelectionToFloating(canvas, selection, sourceCanvas, isBg);
        if (!lifted) return;
        floatCanvas = lifted.floatingCanvas;
        beforeData = lifted.beforeImageData;
        const isMono = colorMode === 'monochrome' || activeLayer?.expressionColor === 'monochrome';
        globalTileGrid.ingestCanvas(activeLayerId, canvas, isMono ? 'monochrome-1bit' : 'color-32bit');
        globalTileGrid.notifyChange(true);
        updateLayerThumbnail(activeLayerId, true);
      }

      const quad = createDefaultPerspectiveQuad(floatX, floatY, floatCanvas.width, floatCanvas.height, 0);
      setTransformSession({
        active: true,
        layerId: activeLayerId,
        sourceCanvas: floatCanvas,
        beforeImageData: beforeData || ctx.getImageData(0, 0, canvas.width, canvas.height),
        bounds: { x: floatX, y: floatY, width: floatCanvas.width, height: floatCanvas.height },
        x: floatX,
        y: floatY,
        width: floatCanvas.width,
        height: floatCanvas.height,
        rotation: 0,
        flipH: false,
        flipV: false,
        isSelection: true,
        mode: 'affine',
        perspectiveQuad: quad,
        meshCols: 4,
        meshRows: 4,
        meshPoints: createDefaultMeshPoints(quad, 4, 4),
      });
      setSelection(null);
    } else {
      const isMultiLayer = !selection && selectedLayerIds && selectedLayerIds.length > 1;
      const multiTargetLayers = isMultiLayer
        ? layers.filter((l) => selectedLayerIds.includes(l.id) && l.type === 'raster')
        : [];

      if (isMultiLayer && multiTargetLayers.length > 1) {
        // Multi-Layer Batch Transform
        const layerBeforeImages = new Map<string, ImageData>();
        const layerSourceCanvases = new Map<string, HTMLCanvasElement>();

        let minX = Infinity;
        let minY = Infinity;
        let maxX = -Infinity;
        let maxY = -Infinity;

        for (const lyr of multiTargetLayers) {
          const c = layerCanvasesRef.current.get(lyr.id);
          if (!c) continue;
          const cCtx = get2DContext(c);
          if (!cCtx) continue;
          const bData = cCtx.getImageData(0, 0, c.width, c.height);
          layerBeforeImages.set(lyr.id, bData);

          const cb = getCanvasContentBounds(c, lyr.id === 'layer-bg' || lyr.id.startsWith('layer-bg'));
          if (cb) {
            minX = Math.min(minX, cb.x);
            minY = Math.min(minY, cb.y);
            maxX = Math.max(maxX, cb.x + cb.width);
            maxY = Math.max(maxY, cb.y + cb.height);
          }
        }

        if (!isFinite(minX) || !isFinite(minY) || maxX <= minX || maxY <= minY) {
          showToast('Selected layers are empty');
          return;
        }

        const b = {
          x: Math.max(0, minX),
          y: Math.max(0, minY),
          width: Math.max(1, maxX - minX),
          height: Math.max(1, maxY - minY),
        };

        const compositeCanvas = document.createElement('canvas');
        compositeCanvas.width = b.width;
        compositeCanvas.height = b.height;
        const compCtx = get2DContext(compositeCanvas);

        const orderedLayers = multiTargetLayers.slice().reverse();
        for (const lyr of orderedLayers) {
          const c = layerCanvasesRef.current.get(lyr.id);
          if (!c) continue;
          const cCtx = get2DContext(c);
          if (!cCtx) continue;

          const sCanvas = document.createElement('canvas');
          sCanvas.width = b.width;
          sCanvas.height = b.height;
          const sCtx = get2DContext(sCanvas);
          if (sCtx) {
            sCtx.drawImage(c, -b.x, -b.y);
            layerSourceCanvases.set(lyr.id, sCanvas);
          }

          if (compCtx) {
            compCtx.save();
            compCtx.globalAlpha = lyr.opacity;
            compCtx.drawImage(sCanvas, 0, 0);
            compCtx.restore();
          }

          const isLayerBg = lyr.id === 'layer-bg' || lyr.id.startsWith('layer-bg');
          if (isLayerBg) {
            cCtx.fillStyle = '#ffffff';
            cCtx.fillRect(b.x, b.y, b.width, b.height);
          } else {
            cCtx.clearRect(b.x, b.y, b.width, b.height);
          }

          const existingSrc = layerSourceCanvasesRef.current?.get(lyr.id);
          if (existingSrc) {
            const escCtx = get2DContext(existingSrc);
            if (escCtx) {
              if (isLayerBg) {
                escCtx.fillStyle = '#ffffff';
                escCtx.fillRect(b.x, b.y, b.width, b.height);
              } else {
                escCtx.clearRect(b.x, b.y, b.width, b.height);
              }
            }
          }
          const isMono = colorMode === 'monochrome' || lyr.expressionColor === 'monochrome';
          globalTileGrid.ingestCanvas(lyr.id, c, isMono ? 'monochrome-1bit' : 'color-32bit');
          updateLayerThumbnail(lyr.id, true);
        }
        globalTileGrid.notifyChange(true);

        const quad = createDefaultPerspectiveQuad(b.x, b.y, b.width, b.height, 0);
        setTransformSession({
          active: true,
          layerId: activeLayerId,
          layerIds: multiTargetLayers.map((l) => l.id),
          layerSourceCanvases,
          layerBeforeImages,
          sourceCanvas: compositeCanvas,
          beforeImageData: layerBeforeImages.get(activeLayerId) || Array.from(layerBeforeImages.values())[0],
          bounds: { x: b.x, y: b.y, width: b.width, height: b.height },
          x: b.x,
          y: b.y,
          width: b.width,
          height: b.height,
          rotation: 0,
          flipH: false,
          flipV: false,
          isSelection: false,
          mode: 'affine',
          perspectiveQuad: quad,
          meshCols: 4,
          meshRows: 4,
          meshPoints: createDefaultMeshPoints(quad, 4, 4),
        });
        setTool('transform');
        return;
      }

      const beforeImageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
      const contentBounds = getCanvasContentBounds(canvas, isBg);
      let b = contentBounds;
      if (!b) {
        if (isBg) {
          b = { x: 0, y: 0, width: canvas.width, height: canvas.height };
        } else {
          showToast('Active layer is empty');
          return;
        }
      }

      const sourceCanvas = document.createElement('canvas');
      sourceCanvas.width = b.width;
      sourceCanvas.height = b.height;
      const sCtx = get2DContext(sourceCanvas);
      if (sCtx) {
        const sliceData = ctx.getImageData(b.x, b.y, b.width, b.height);
        sCtx.putImageData(sliceData, 0, 0);
      }

      if (isBg) {
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(b.x, b.y, b.width, b.height);
      } else {
        ctx.clearRect(b.x, b.y, b.width, b.height);
      }

      const existingSourceCanvas = layerSourceCanvasesRef.current?.get(activeLayerId);
      if (existingSourceCanvas) {
        const escCtx = get2DContext(existingSourceCanvas);
        if (escCtx) {
          if (isBg) {
            escCtx.fillStyle = '#ffffff';
            escCtx.fillRect(b.x, b.y, b.width, b.height);
          } else {
            escCtx.clearRect(b.x, b.y, b.width, b.height);
          }
        }
      }

      const isMono = colorMode === 'monochrome' || activeLayer?.expressionColor === 'monochrome';
      globalTileGrid.ingestCanvas(activeLayerId, canvas, isMono ? 'monochrome-1bit' : 'color-32bit');
      globalTileGrid.notifyChange(true);
      updateLayerThumbnail(activeLayerId, true);

      const quad = createDefaultPerspectiveQuad(b.x, b.y, b.width, b.height, 0);
      setTransformSession({
        active: true,
        layerId: activeLayerId,
        sourceCanvas,
        beforeImageData,
        bounds: { x: b.x, y: b.y, width: b.width, height: b.height },
        x: b.x,
        y: b.y,
        width: b.width,
        height: b.height,
        rotation: 0,
        flipH: false,
        flipV: false,
        isSelection: false,
        mode: 'affine',
        perspectiveQuad: quad,
        meshCols: 4,
        meshRows: 4,
        meshPoints: createDefaultMeshPoints(quad, 4, 4),
      });
    }
    setTool('transform');
  }, [transformSession, getActiveCanvas, selection, activeLayerId, selectedLayerIds, layers, layerSourceCanvasesRef, updateLayerThumbnail, showToast]);

  const handleApplyTransform = useCallback(() => {
    if (!transformSession) return;

    if (transformSession.layerIds && transformSession.layerIds.length > 1 && transformSession.layerSourceCanvases) {
      for (const lId of transformSession.layerIds) {
        const c = layerCanvasesRef.current.get(lId);
        const sCanvas = transformSession.layerSourceCanvases.get(lId);
        if (!c || !sCanvas) continue;
        const cCtx = get2DContext(c);
        if (!cCtx) continue;

        const drawLayerTransformed = (targetCtx: CanvasRenderingContext2D) => {
          targetCtx.save();
          if (transformSession.mode === 'perspective' && transformSession.perspectiveQuad) {
            renderPerspectiveQuad(targetCtx, sCanvas, transformSession.perspectiveQuad, 24);
          } else if (transformSession.mode === 'mesh' && transformSession.meshPoints) {
            renderMeshWarp(targetCtx, sCanvas, transformSession.meshPoints, 6);
          } else {
            const cx = transformSession.x + transformSession.width / 2;
            const cy = transformSession.y + transformSession.height / 2;
            targetCtx.translate(cx, cy);
            targetCtx.rotate((transformSession.rotation * Math.PI) / 180);
            targetCtx.scale(transformSession.flipH ? -1 : 1, transformSession.flipV ? -1 : 1);
            targetCtx.drawImage(
              sCanvas,
              -transformSession.width / 2,
              -transformSession.height / 2,
              transformSession.width,
              transformSession.height
            );
          }
          targetCtx.restore();
        };

        drawLayerTransformed(cCtx);

        const existingSrc = layerSourceCanvasesRef.current?.get(lId);
        if (existingSrc) {
          const sCtx = get2DContext(existingSrc);
          if (sCtx) drawLayerTransformed(sCtx);
        }

        const lyr = layers.find((l) => l.id === lId);
        if (lyr?.toneEnabled && existingSrc) {
          applyScreentone(existingSrc, c, {
            frequency: lyr.toneFrequency ?? 60,
            angle: lyr.toneAngle ?? 45,
            dotShape: lyr.toneDotShape ?? 'circle',
            dpi: dimensions.dpi ?? 600,
          });
        }

        const beforeDataForLayer = transformSession.layerBeforeImages?.get(lId);
        const afterDataForLayer = cCtx.getImageData(0, 0, c.width, c.height);
        const isMono = colorMode === 'monochrome' || lyr?.expressionColor === 'monochrome';
        globalTileGrid.ingestCanvas(lId, c, isMono ? 'monochrome-1bit' : 'color-32bit');
        if (beforeDataForLayer) {
          pushHistoryStep(
            'transform',
            'Batch Free Transform',
            beforeDataForLayer,
            afterDataForLayer,
            lId
          );
        }
        updateLayerThumbnail(lId, true);
      }

      globalTileGrid.notifyChange(true);
      setTransformSession(null);
      setTool('brush');
      return;
    }

    const canvas = layerCanvasesRef.current.get(transformSession.layerId) || getActiveCanvas();
    if (!canvas) return;
    const ctx = get2DContext(canvas);
    if (!ctx) return;

    const sourceCanvas = layerSourceCanvasesRef.current?.get(transformSession.layerId);

    const drawTransformed = (targetCtx: CanvasRenderingContext2D) => {
      targetCtx.save();
      if (transformSession.mode === 'perspective' && transformSession.perspectiveQuad) {
        renderPerspectiveQuad(targetCtx, transformSession.sourceCanvas, transformSession.perspectiveQuad, 24);
      } else if (transformSession.mode === 'mesh' && transformSession.meshPoints) {
        renderMeshWarp(targetCtx, transformSession.sourceCanvas, transformSession.meshPoints, 6);
      } else {
        const cx = transformSession.x + transformSession.width / 2;
        const cy = transformSession.y + transformSession.height / 2;
        targetCtx.translate(cx, cy);
        targetCtx.rotate((transformSession.rotation * Math.PI) / 180);
        targetCtx.scale(transformSession.flipH ? -1 : 1, transformSession.flipV ? -1 : 1);
        targetCtx.drawImage(
          transformSession.sourceCanvas,
          -transformSession.width / 2,
          -transformSession.height / 2,
          transformSession.width,
          transformSession.height
        );
      }
      targetCtx.restore();
    };

    drawTransformed(ctx);
    if (sourceCanvas) {
      const sCtx = get2DContext(sourceCanvas);
      if (sCtx) drawTransformed(sCtx);
    }

    const layer = layers.find((l) => l.id === transformSession.layerId);
    if (layer?.toneEnabled && sourceCanvas) {
      applyScreentone(
        sourceCanvas,
        canvas,
        {
          frequency: layer.toneFrequency ?? 60,
          angle: layer.toneAngle ?? 45,
          dotShape: layer.toneDotShape ?? 'circle',
          dpi: dimensions.dpi ?? 600,
        }
      );
    }

    const afterImageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
    pushHistoryStep(
      'transform',
      'Free Transform',
      transformSession.beforeImageData,
      afterImageData,
      transformSession.layerId
    );
    globalTileGrid.notifyChange(true);

    updateLayerThumbnail(transformSession.layerId, true);
    setTransformSession(null);
    setTool('brush');
  }, [
    transformSession,
    colorMode,
    layerCanvasesRef,
    getActiveCanvas,
    layers,
    layerSourceCanvasesRef,
    dimensions.dpi,
    pushHistoryStep,
    updateLayerThumbnail,
  ]);

  const handleCancelTransform = useCallback(() => {
    if (!transformSession) return;

    if (transformSession.layerBeforeImages && transformSession.layerBeforeImages.size > 0) {
      for (const [lId, beforeData] of transformSession.layerBeforeImages.entries()) {
        const c = layerCanvasesRef.current.get(lId);
        if (c && beforeData) {
          const ctx = get2DContext(c);
          ctx?.putImageData(beforeData, 0, 0);

          const lyr = layers.find((l) => l.id === lId);
          const sourceCanvas = layerSourceCanvasesRef.current?.get(lId);
          if (sourceCanvas) {
            const sCtx = get2DContext(sourceCanvas);
            sCtx?.putImageData(beforeData, 0, 0);

            if (lyr?.toneEnabled) {
              applyScreentone(sourceCanvas, c, {
                frequency: lyr.toneFrequency ?? 60,
                angle: lyr.toneAngle ?? 45,
                dotShape: lyr.toneDotShape ?? 'circle',
                dpi: dimensions.dpi ?? 600,
              });
            }
          }
          const isMono = colorMode === 'monochrome' || lyr?.expressionColor === 'monochrome';
          globalTileGrid.ingestCanvas(lId, c, isMono ? 'monochrome-1bit' : 'color-32bit');
          updateLayerThumbnail(lId, true);
        }
      }
      globalTileGrid.notifyChange(true);
      setTransformSession(null);
      setTool('brush');
      return;
    }

    const canvas = layerCanvasesRef.current.get(transformSession.layerId) || getActiveCanvas();
    if (canvas && transformSession.beforeImageData) {
      const ctx = get2DContext(canvas);
      ctx?.putImageData(transformSession.beforeImageData, 0, 0);

      const layer = layers.find((l) => l.id === transformSession.layerId);
      const sourceCanvas = layerSourceCanvasesRef.current?.get(transformSession.layerId);
      if (sourceCanvas) {
        const sCtx = get2DContext(sourceCanvas);
        sCtx?.putImageData(transformSession.beforeImageData, 0, 0);

        if (layer?.toneEnabled) {
          applyScreentone(
            sourceCanvas,
            canvas,
            {
              frequency: layer.toneFrequency ?? 60,
              angle: layer.toneAngle ?? 45,
              dotShape: layer.toneDotShape ?? 'circle',
              dpi: dimensions.dpi ?? 600,
            }
          );
        }
      }
      const isMono = colorMode === 'monochrome' || layer?.expressionColor === 'monochrome';
      globalTileGrid.ingestCanvas(transformSession.layerId, canvas, isMono ? 'monochrome-1bit' : 'color-32bit');
      globalTileGrid.notifyChange(true);
      updateLayerThumbnail(transformSession.layerId, true);
    }
    setTransformSession(null);
    setTool('brush');
  }, [
    transformSession,
    colorMode,
    layerCanvasesRef,
    getActiveCanvas,
    layers,
    layerSourceCanvasesRef,
    dimensions.dpi,
    updateLayerThumbnail,
  ]);

  const handleConfirmText = useCallback(() => {
    if (!textSession || !textSession.settings.text.trim()) {
      setTextSession(null);
      return;
    }
    const canvas = getActiveCanvas();
    if (!canvas) return;
    const ctx = get2DContext(canvas);
    if (!ctx) return;

    const beforeImageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const sourceCanvas = layerSourceCanvasesRef.current?.get(activeLayerId);

    const renderTextOn = (target: HTMLCanvasElement) => {
      const c = get2DContext(target);
      if (!c) return;
      const s = textSession.settings;
      renderMangaTextToCanvas(c, s.text, textSession.x, textSession.y, {
        fontSize: s.fontSize,
        fontFamily: s.fontFamily,
        writingMode: s.writingMode || 'horizontal-tb',
        bold: s.bold,
        italic: s.italic,
        align: s.align,
        color: s.color,
        outline: s.outline,
        outlineColor: s.outlineColor,
        outlineWidth: s.outlineWidth,
        anchorTopLeft: true,
      });
    };

    renderTextOn(canvas);
    if (sourceCanvas) renderTextOn(sourceCanvas);

    const afterImageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
    updateLayerThumbnail(activeLayerId, true);
    pushHistoryStep(
      'text',
      'Manga Text',
      beforeImageData,
      afterImageData,
      activeLayerId
    );
    globalTileGrid.notifyChange(true);

    setTextSession(null);
  }, [textSession, getActiveCanvas, activeLayerId, layerSourceCanvasesRef, updateLayerThumbnail, pushHistoryStep]);

  const handleCancelText = useCallback(() => {
    setTextSession(null);
  }, []);

  const handleConfirmBalloon = useCallback(() => {
    if (!activeBalloon) return;
    const canvas = getActiveCanvas();
    if (!canvas) return;
    const ctx = get2DContext(canvas);
    if (!ctx) return;

    const beforeImageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const sourceCanvas = layerSourceCanvasesRef.current?.get(activeLayerId);

    const drawOn = (target: HTMLCanvasElement) => {
      const c = get2DContext(target);
      if (!c) return;
      renderSpeechBalloon(c, activeBalloon);
    };

    drawOn(canvas);
    if (sourceCanvas) drawOn(sourceCanvas);

    const afterImageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
    updateLayerThumbnail(activeLayerId, true);
    pushHistoryStep(
      'frame',
      'Speech Balloon',
      beforeImageData,
      afterImageData,
      activeLayerId
    );
    globalTileGrid.notifyChange(true);

    setActiveBalloon(null);
  }, [activeBalloon, getActiveCanvas, activeLayerId, layerSourceCanvasesRef, updateLayerThumbnail, pushHistoryStep]);

  const handleDeleteBalloon = useCallback(() => {
    setActiveBalloon(null);
  }, []);

  const handleApplyMangaEffects = useCallback(
    (type: 'saturated' | 'stream', options: SaturatedLinesOptions | StreamLinesOptions) => {
      const canvas = getActiveCanvas();
      if (!canvas) return;
      const ctx = get2DContext(canvas);
      if (!ctx) return;

      const beforeImageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
      const sourceCanvas = layerSourceCanvasesRef.current?.get(activeLayerId);

      const renderOn = (target: HTMLCanvasElement) => {
        const c = get2DContext(target);
        if (!c) return;
        if (type === 'saturated') {
          renderSaturatedLines(c, canvas.width, canvas.height, options as SaturatedLinesOptions);
        } else {
          renderStreamLines(c, canvas.width, canvas.height, options as StreamLinesOptions);
        }
      };

      renderOn(canvas);
      if (sourceCanvas) renderOn(sourceCanvas);

      const afterImageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
      updateLayerThumbnail(activeLayerId, true);
      pushHistoryStep('brush', `Manga Effect (${type})`, beforeImageData, afterImageData, activeLayerId);
      globalTileGrid.notifyChange(true);
      showToast(`Applied manga ${type} lines`);
    },
    [getActiveCanvas, activeLayerId, layerSourceCanvasesRef, updateLayerThumbnail, pushHistoryStep, showToast]
  );

  const handleInsert3DRasterLayer = useCallback(
    (layer: LayerItem, canvas: HTMLCanvasElement) => {
      if (layer.type === 'folder') {
        addLayer('folder', layer.parentId, layer.name, layer.id);
      } else {
        pasteLayerFromCanvas(canvas, layer.name, layer.blendMode, layer.opacity, layer.id, layer);
      }
      showToast(`Added 3D layer "${layer.name}".`);
    },
    [addLayer, pasteLayerFromCanvas, showToast]
  );

  const handleFillScreentone = useCallback(() => {
    setIsToneModalOpen(true);
  }, []);

  const handleConfirmTone = useCallback(
    (settings: SimpleToneSettings) => {
      setIsToneModalOpen(false);
      const { id, canvas } = fillScreentoneSelection(
        selection,
        settings.density,
        settings.frequency,
        settings.angle,
        settings.dotShape,
        settings.densityType
      );
      const ctx = get2DContext(canvas);
      if (ctx) {
        const afterData = ctx.getImageData(0, 0, canvas.width, canvas.height);
        pushHistoryStep(
          'screentone',
          `Screentone (${settings.density}%)`,
          null,
          afterData,
          id
        );
      }
      showToast(`Created Screentone Layer (${settings.density}%)`);
    },
    [selection, fillScreentoneSelection, pushHistoryStep, showToast]
  );

  // Apply previewed Expression Color permanently to layer with Undo history
  const handleApplyExpressionColor = useCallback(
    (layerId: string) => {
      const result = applyExpressionColorOfPreview(layerId);
      if (result && result.beforeImageData && result.afterImageData) {
        pushHistoryStep(
          'expression-color',
          'Apply Expression Color',
          result.beforeImageData,
          result.afterImageData,
          layerId
        );
        showToast('Applied expression color to layer');
      }
    },
    [applyExpressionColorOfPreview, pushHistoryStep, showToast]
  );

  // Apply Layer Color Tint permanently to layer with Undo history
  const handleApplyLayerColor = useCallback(
    (layerId: string) => {
      const result = applyLayerColorPermanently(layerId);
      if (result && result.beforeImageData && result.afterImageData) {
        pushHistoryStep(
          'layer-color',
          'Apply Layer Color Tint',
          result.beforeImageData,
          result.afterImageData,
          layerId
        );
        showToast('Applied tint to layer permanently');
      }
    },
    [applyLayerColorPermanently, pushHistoryStep, showToast]
  );

  // Direct conversion of layer to Color, Gray, or Monochrome with Undo history
  const handleConvertLayer = useCallback(
    (
      layerId: string,
      targetMode: ExpressionColor,
      options?: { threshold?: number; expressBlack?: boolean; expressWhite?: boolean }
    ) => {
      const result = convertLayer(layerId, targetMode, options);
      if (result && result.beforeImageData && result.afterImageData) {
        pushHistoryStep(
          'layer-convert',
          `Convert to ${targetMode.toUpperCase()}`,
          result.beforeImageData,
          result.afterImageData,
          layerId
        );
        showToast(`Converted layer to ${targetMode}`);
      }
    },
    [convertLayer, pushHistoryStep, showToast]
  );

  const startLiquifyLoop = useCallback(
    (canvas: HTMLCanvasElement, sourceCanvas: HTMLCanvasElement | undefined, isTone: boolean) => {
      if (liquifyRafIdRef.current) cancelAnimationFrame(liquifyRafIdRef.current);

      const tick = () => {
        if (!isLiquifyingRef.current || !liquifyLastPointerPosRef.current) {
          liquifyRafIdRef.current = null;
          return;
        }
        const { pt, pressure } = liquifyLastPointerPosRef.current;
        const dirty = applyLiquifyStep({
          canvas,
          sourceCanvas: isTone ? sourceCanvas : undefined,
          cx: pt.x,
          cy: pt.y,
          prevX: pt.x,
          prevY: pt.y,
          settings: liquifySettingsRef.current,
          pressure,
          initialImageData: liquifyInitialImageDataRef.current,
          selectionMask: liquifySelectionMaskRef.current,
        });

        if (dirty) {
          if (activeLayer?.toneEnabled && sourceCanvas) {
            const displayCanvas = layerCanvasesRef.current.get(activeLayerId);
            if (displayCanvas) {
              applyLayerEffects(sourceCanvas, displayCanvas, activeLayer, dimensions.dpi ?? 600, dirty);
            }
          } else {
            const dCtx = get2DContext(canvas);
            if (dCtx && dirty.width > 0 && dirty.height > 0) {
              const subData = dCtx.getImageData(dirty.x, dirty.y, dirty.width, dirty.height);
              const isMono = colorMode === 'monochrome' || activeLayer?.expressionColor === 'monochrome';
              globalTileGrid.writeImageData(activeLayerId, subData, dirty.x, dirty.y, isMono ? 'monochrome-1bit' : 'color-32bit');
            }
          }
          globalTileGrid.notifyChange(true);
        }

        liquifyRafIdRef.current = requestAnimationFrame(tick);
      };

      liquifyRafIdRef.current = requestAnimationFrame(tick);
    },
    [activeLayer, activeLayerId, colorMode, dimensions.dpi, layerCanvasesRef]
  );

  const handlePointerDown = useCallback(
    (e: React.PointerEvent<HTMLElement>, coalescedEvents?: PointerEvent[]) => {
      if (!hasOpenDocument || e.button !== 0) return;

      const pt = getCanvasCoords(e);

      if (tool === 'pipette') {
        e.preventDefault();
        try {
          (e.target as HTMLElement).setPointerCapture(e.pointerId);
        } catch {}
        isPipetteSamplingRef.current = true;
        handleSampleColor(pt);
        return;
      }

      if (tool === 'liquify') {
        e.preventDefault();
        if (!activeLayer || activeLayer.locked || (activeLayer && !isLayerEffectivelyVisible(activeLayer))) return;
        const targetLayerId = activeLayerId;
        const isTone = Boolean(activeLayer?.toneEnabled && layerSourceCanvasesRef.current?.get(targetLayerId));
        const sourceCanvas = layerSourceCanvasesRef.current?.get(targetLayerId);
        const displayCanvas = layerCanvasesRef.current.get(targetLayerId);
        const canvas = (isTone && sourceCanvas) ? sourceCanvas : displayCanvas;
        if (!canvas) return;

        const ctx = get2DContext(canvas);
        if (!ctx) return;

        isLiquifyingRef.current = true;
        prevLiquifyPointRef.current = pt;
        liquifyBeforeImageDataRef.current = ctx.getImageData(0, 0, canvas.width, canvas.height);
        liquifyInitialImageDataRef.current = liquifyBeforeImageDataRef.current;
        liquifySelectionMaskRef.current = createLiquifySelectionMask(selection, canvas.width, canvas.height);
        liquifyDirtyRectRef.current = null;
        liquifyLastPointerPosRef.current = { pt, pressure: e.pressure || 1.0 };

        try {
          (e.target as HTMLElement).setPointerCapture(e.pointerId);
        } catch {}

        const mode = liquifySettingsRef.current.mode;
        if (mode === 'expand' || mode === 'pinch' || mode === 'twirl-cw' || mode === 'twirl-ccw' || mode === 'reconstruct') {
          const dirty = applyLiquifyStep({
            canvas,
            sourceCanvas: isTone ? sourceCanvas : undefined,
            cx: pt.x,
            cy: pt.y,
            prevX: pt.x,
            prevY: pt.y,
            settings: liquifySettingsRef.current,
            pressure: e.pressure || 1.0,
            initialImageData: liquifyInitialImageDataRef.current,
            selectionMask: liquifySelectionMaskRef.current,
          });
          if (dirty) {
            liquifyDirtyRectRef.current = dirty;
            if (activeLayer?.toneEnabled && sourceCanvas && displayCanvas) {
              applyLayerEffects(sourceCanvas, displayCanvas, activeLayer, dimensions.dpi ?? 600, dirty);
            } else if (dirty.width > 0 && dirty.height > 0) {
              const subData = ctx.getImageData(dirty.x, dirty.y, dirty.width, dirty.height);
              const isMono = colorMode === 'monochrome' || activeLayer?.expressionColor === 'monochrome';
              globalTileGrid.writeImageData(targetLayerId, subData, dirty.x, dirty.y, isMono ? 'monochrome-1bit' : 'color-32bit');
            }
            globalTileGrid.notifyChange(true);
          }
          startLiquifyLoop(canvas, sourceCanvas, isTone);
        }
        return;
      }

      if (tool === 'brush' || tool === 'eraser') {
        if (selection?.floating) {
          handleCommitFloatingSelection();
        }
        handleCanvasDrawingPointerDown(e, coalescedEvents);
        return;
      }

      if (tool === 'select-wand') {
        e.preventDefault();
        if (selection?.floating) {
          handleCommitFloatingSelection();
        }

        const px = Math.floor(pt.x);
        const py = Math.floor(pt.y);
        if (px < 0 || px >= dimensions.width || py < 0 || py >= dimensions.height) return;

        let sampleCanvas: HTMLCanvasElement | null = null;
        if (wandSettings.referMode === 'all') {
          sampleCanvas = compositeVisibleLayers(layers, layerCanvasesRef.current, dimensions);
        } else if (wandSettings.referMode === 'reference') {
          const refLayer = layers.find((l) => l.isReference && l.visible);
          if (refLayer) {
            sampleCanvas = layerCanvasesRef.current.get(refLayer.id) || null;
          } else {
            sampleCanvas = layerCanvasesRef.current.get(activeLayerId) || getActiveCanvas();
          }
        } else {
          sampleCanvas = layerCanvasesRef.current.get(activeLayerId) || getActiveCanvas();
        }

        if (!sampleCanvas) return;
        const sCtx = get2DContext(sampleCanvas);
        if (!sCtx) return;

        const w = dimensions.width;
        const h = dimensions.height;
        const sampleImageData = sCtx.getImageData(0, 0, w, h);
        const { mask, bounds } = floodSelectWand(
          sampleImageData,
          w,
          h,
          px,
          py,
          wandSettings
        );

        if (!bounds || bounds.width === 0 || bounds.height === 0) {
          setSelection(null);
          return;
        }

        const svgPath = maskToSvgPath(mask, w, h);
        setSelection({
          type: 'wand',
          bounds,
          mask,
          maskWidth: w,
          maskHeight: h,
          svgPath,
        });
        return;
      }

      if (tool === 'select-pen' || tool === 'select-eraser') {
        e.preventDefault();
        if (selection?.floating) {
          handleCommitFloatingSelection();
        }

        const w = dimensions.width;
        const h = dimensions.height;
        let maskCanvas = selectionMaskCanvasRef.current;
        if (!maskCanvas || maskCanvas.width !== w || maskCanvas.height !== h) {
          maskCanvas = document.createElement('canvas');
          maskCanvas.width = w;
          maskCanvas.height = h;
          selectionMaskCanvasRef.current = maskCanvas;
        }

        const mCtx = get2DContext(maskCanvas);
        if (!mCtx) return;

        mCtx.clearRect(0, 0, w, h);
        if (selection) {
          const currentMask = selectionToMask(selection, w, h);
          const imgData = mCtx.createImageData(w, h);
          for (let i = 0; i < currentMask.length; i++) {
            const val = currentMask[i];
            const idx = i * 4;
            imgData.data[idx] = val;
            imgData.data[idx + 1] = val;
            imgData.data[idx + 2] = val;
            imgData.data[idx + 3] = val > 0 ? 255 : 0;
          }
          mCtx.putImageData(imgData, 0, 0);
        }

        const brushSize = brushSettings.size;
        mCtx.save();
        mCtx.lineCap = 'round';
        mCtx.lineJoin = 'round';
        mCtx.lineWidth = brushSize;
        if (tool === 'select-pen') {
          mCtx.globalCompositeOperation = 'source-over';
          mCtx.fillStyle = '#ffffff';
          mCtx.strokeStyle = '#ffffff';
        } else {
          mCtx.globalCompositeOperation = 'destination-out';
          mCtx.fillStyle = '#000000';
          mCtx.strokeStyle = '#000000';
        }

        mCtx.beginPath();
        mCtx.arc(pt.x, pt.y, brushSize / 2, 0, Math.PI * 2);
        mCtx.fill();
        mCtx.restore();

        selectionPenDrawingRef.current = {
          isDrawing: true,
          lastPt: pt,
          maskCanvas,
          ctx: mCtx,
        };

        const mImgData = mCtx.getImageData(0, 0, w, h);
        const newMask = new Uint8Array(w * h);
        for (let i = 0; i < newMask.length; i++) {
          newMask[i] = mImgData.data[i * 4 + 3] > 0 ? 255 : 0;
        }
        const b = maskToBounds(newMask, w, h);
        if (b) {
          const svg = maskToSvgPath(newMask, w, h);
          setSelection({
            type: 'mask',
            bounds: b,
            mask: newMask,
            maskWidth: w,
            maskHeight: h,
            svgPath: svg,
          });
        } else {
          setSelection(null);
        }
        return;
      }

      if (tool === 'select-rect' || tool === 'select-lasso') {
        e.preventDefault();
        if (selection && isPointInSelection(pt.x, pt.y, selection)) {
          const canvas = getActiveCanvas();
          if (!canvas) return;

          if (!selection.floating) {
            const sourceCanvas = layerSourceCanvasesRef.current?.get(activeLayerId);
            const isBg = activeLayerId === 'layer-bg' || activeLayerId.startsWith('layer-bg');
            const lifted = liftSelectionToFloating(canvas, selection, sourceCanvas, isBg);
            if (lifted) {
              const isMono = colorMode === 'monochrome' || activeLayer?.expressionColor === 'monochrome';
              globalTileGrid.ingestCanvas(activeLayerId, canvas, isMono ? 'monochrome-1bit' : 'color-32bit');
              globalTileGrid.notifyChange(true);
              updateLayerThumbnail(activeLayerId, true);
              const floatingObj = {
                canvas: lifted.floatingCanvas,
                x: selection.bounds.x,
                y: selection.bounds.y,
                origX: selection.bounds.x,
                origY: selection.bounds.y,
                layerId: activeLayerId,
                beforeImageData: lifted.beforeImageData,
              };
              setSelection({
                ...selection,
                floating: floatingObj,
              });
              selectionDragRef.current = {
                isDragging: true,
                startX: pt.x,
                startY: pt.y,
                origFloatingX: selection.bounds.x,
                origFloatingY: selection.bounds.y,
                origBoundsX: selection.bounds.x,
                origBoundsY: selection.bounds.y,
              };
            }
          } else {
            selectionDragRef.current = {
              isDragging: true,
              startX: pt.x,
              startY: pt.y,
              origFloatingX: selection.floating.x,
              origFloatingY: selection.floating.y,
              origBoundsX: selection.bounds.x,
              origBoundsY: selection.bounds.y,
            };
          }
          return;
        }

        if (selection?.floating) {
          handleCommitFloatingSelection();
        }

        if (tool === 'select-rect') {
          selectRectStartRef.current = pt;
          setSelection({
            type: 'rect',
            bounds: { x: pt.x, y: pt.y, width: 0, height: 0 },
          });
        } else {
          lassoPointsRef.current = [pt];
          setSelection({
            type: 'lasso',
            bounds: { x: pt.x, y: pt.y, width: 0, height: 0 },
            polygon: [pt],
          });
        }
        return;
      }

      if (tool === 'fill') {
        e.preventDefault();
        if (fillSettings.method === 'lasso') {
          lassoFillPointsRef.current = [pt];
          return;
        }

        const px = Math.floor(pt.x);
        const py = Math.floor(pt.y);
        if (px < 0 || px >= dimensions.width || py < 0 || py >= dimensions.height) return;

        const canvas = getActiveCanvas();
        if (!canvas || activeLayer?.locked || (activeLayer && !isLayerEffectivelyVisible(activeLayer))) return;

        const ctx = get2DContext(canvas);
        if (!ctx) return;
        const beforeImageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
        const sourceCanvas = layerSourceCanvasesRef.current?.get(activeLayerId);

        let refCanvas: HTMLCanvasElement;
        if (fillSettings.method === 'refer-all') {
          refCanvas = compositeVisibleLayers(layers, layerCanvasesRef.current, dimensions);
        } else if (fillSettings.method === 'refer-reference') {
          refCanvas = compositeReferenceLayers(layers, layerCanvasesRef.current, dimensions);
        } else {
          refCanvas = canvas;
        }

        const selMask = selection ? createSelectionMask(selection, canvas.width, canvas.height) : null;
        const fillRes = executeFloodFill(
          canvas,
          refCanvas,
          px,
          py,
          primaryColor,
          fillSettings.tolerance,
          sourceCanvas,
          {
            closeGap: fillSettings.closeGap ?? 0,
            areaScale: fillSettings.areaScale ?? 0,
            antiAlias: fillSettings.antiAlias ?? true,
            selectionMask: selMask,
          }
        );
        if (activeLayer?.toneEnabled && sourceCanvas) {
          applyLayerEffects(sourceCanvas, canvas, activeLayer, dimensions.dpi ?? 600, fillRes.dirtyRect ?? undefined);
        }

        const afterImageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
        updateLayerThumbnail(activeLayerId, true);
        pushHistoryStep(
          'fill',
          'Bucket Fill',
          beforeImageData,
          afterImageData,
          activeLayerId
        );
        globalTileGrid.notifyChange(true);
        return;
      }

      if (tool === 'frame') {
        e.preventDefault();
        frameStartRef.current = pt;
        return;
      }

      if (tool === 'text') {
        e.preventDefault();
        setTextSession({
          x: Math.round(pt.x),
          y: Math.round(pt.y),
          settings: { ...textSettings },
        });
        return;
      }

      if (tool === 'balloon') {
        e.preventDefault();
        const newBalloon = createDefaultSpeechBalloon(
          Math.round(pt.x - 100),
          Math.round(pt.y - 70),
          200,
          140,
          balloonSettings.shape
        );
        newBalloon.strokeWidth = balloonSettings.strokeWidth;
        newBalloon.strokeColor = primaryColor || '#000000';
        newBalloon.fillColor = balloonSettings.fillColor || '#ffffff';
        newBalloon.vertical = balloonSettings.vertical;
        setActiveBalloon(newBalloon);
        return;
      }

      if (tool === 'vector-edit') {
        e.preventDefault();
        if (!activeLayer || activeLayer.type !== 'vector' || !activeLayer.vectorStrokes) {
          showToast('Select a Vector Layer to use Correct Line tools');
          return;
        }
        isVectorEditingRef.current = true;
        lastVectorEditPtRef.current = pt;
        vectorEditBeforeStrokesRef.current = JSON.parse(JSON.stringify(activeLayer.vectorStrokes));
        return;
      }
    },
    [
      hasOpenDocument,
      getCanvasCoords,
      tool,
      selection,
      handleCommitFloatingSelection,
      handleCanvasDrawingPointerDown,
      getActiveCanvas,
      layerSourceCanvasesRef,
      activeLayerId,
      updateLayerThumbnail,
      fillSettings,
      dimensions.width,
      dimensions.height,
      activeLayer,
      isLayerEffectivelyVisible,
      layers,
      layerCanvasesRef,
      primaryColor,
      pushHistoryStep,
      textSettings,
      handleSampleColor,
      wandSettings,
      brushSettings.size,
      dimensions,
    ]
  );

  const handlePointerMove = useCallback(
    (e: React.PointerEvent<HTMLElement>, coalescedEvents?: PointerEvent[], predictedEvents?: PointerEvent[]) => {
      if (tool === 'pipette') {
        if (isPipetteSamplingRef.current) {
          const pt = getCanvasCoords(e);
          handleSampleColor(pt);
        }
        return;
      }

      if (tool === 'brush' || tool === 'eraser') {
        handleCanvasDrawingPointerMove(e, coalescedEvents, predictedEvents);
        return;
      }

      if (tool === 'vector-edit') {
        if (!isVectorEditingRef.current || !activeLayer?.vectorStrokes) return;
        const pt = getCanvasCoords(e);
        const lastPt = lastVectorEditPtRef.current || pt;
        const delta = { x: pt.x - lastPt.x, y: pt.y - lastPt.y };
        lastVectorEditPtRef.current = pt;

        const radius = vectorEditSettings.radius || 35;
        let updated = false;

        const newStrokes = activeLayer.vectorStrokes.map((stroke) => {
          if (stroke.deleted) return stroke;
          if (
            pt.x < stroke.bounds.minX - radius ||
            pt.x > stroke.bounds.maxX + radius ||
            pt.y < stroke.bounds.minY - radius ||
            pt.y > stroke.bounds.maxY + radius
          ) {
            return stroke;
          }

          if (vectorEditSettings.mode === 'pinch') {
            if (Math.hypot(delta.x, delta.y) > 0.05) {
              updated = true;
              return pinchVectorStroke(stroke, pt, radius, delta);
            }
          } else if (vectorEditSettings.mode === 'width') {
            updated = true;
            return modifyStrokeWidth(stroke, pt, radius, vectorEditSettings.widthFactor);
          } else if (vectorEditSettings.mode === 'simplify') {
            updated = true;
            return simplifyVectorStroke(stroke, vectorEditSettings.simplifyTolerance);
          }
          return stroke;
        });

        if (updated) {
          activeLayer.vectorStrokes = newStrokes;
          const canvas = getActiveCanvas();
          if (canvas) {
            const ctx = get2DContext(canvas);
            if (ctx) {
              ctx.clearRect(0, 0, canvas.width, canvas.height);
              renderVectorLayer(ctx, newStrokes);
              const isMono = colorMode === 'monochrome' || activeLayer.expressionColor === 'monochrome';
              globalTileGrid.ingestCanvas(activeLayerId, canvas, isMono ? 'monochrome-1bit' : 'color-32bit');
              globalTileGrid.notifyChange(true);
              updateLayerThumbnail(activeLayerId, true);
            }
          }
        }
        return;
      }

      if (tool === 'liquify') {
        if (!isLiquifyingRef.current) return;
        const pt = getCanvasCoords(e);
        const pressure = e.pressure || 1.0;
        liquifyLastPointerPosRef.current = { pt, pressure };

        const targetLayerId = activeLayerId;
        const isTone = Boolean(activeLayer?.toneEnabled && layerSourceCanvasesRef.current?.get(targetLayerId));
        const sourceCanvas = layerSourceCanvasesRef.current?.get(targetLayerId);
        const displayCanvas = layerCanvasesRef.current.get(targetLayerId);
        const canvas = (isTone && sourceCanvas) ? sourceCanvas : displayCanvas;
        if (!canvas) return;

        const prev = prevLiquifyPointRef.current || pt;
        const dist = Math.hypot(pt.x - prev.x, pt.y - prev.y);
        const stepDist = Math.max(2, (liquifySettingsRef.current.size / 2) * 0.25);
        const numSteps = Math.max(1, Math.ceil(dist / stepDist));

        let overallDirty: DirtyRect | null = null;
        for (let i = 1; i <= numSteps; i++) {
          const t = i / numSteps;
          const cx = prev.x + (pt.x - prev.x) * t;
          const cy = prev.y + (pt.y - prev.y) * t;
          const px = prev.x + (pt.x - prev.x) * ((i - 1) / numSteps);
          const py = prev.y + (pt.y - prev.y) * ((i - 1) / numSteps);

          const dirty = applyLiquifyStep({
            canvas,
            sourceCanvas: isTone ? sourceCanvas : undefined,
            cx,
            cy,
            prevX: px,
            prevY: py,
            settings: liquifySettingsRef.current,
            pressure,
            initialImageData: liquifyInitialImageDataRef.current,
            selectionMask: liquifySelectionMaskRef.current,
          });

          if (dirty) {
            if (!overallDirty) {
              overallDirty = { ...dirty };
            } else {
              const minX = Math.min(overallDirty.x, dirty.x);
              const minY = Math.min(overallDirty.y, dirty.y);
              const maxX = Math.max(overallDirty.x + overallDirty.width, dirty.x + dirty.width);
              const maxY = Math.max(overallDirty.y + overallDirty.height, dirty.y + dirty.height);
              overallDirty = { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
            }
          }
        }

        prevLiquifyPointRef.current = pt;

        if (overallDirty) {
          if (activeLayer?.toneEnabled && sourceCanvas && displayCanvas) {
            applyLayerEffects(sourceCanvas, displayCanvas, activeLayer, dimensions.dpi ?? 600, overallDirty);
          } else if (overallDirty.width > 0 && overallDirty.height > 0) {
            const cCtx = get2DContext(canvas);
            if (cCtx) {
              const subData = cCtx.getImageData(overallDirty.x, overallDirty.y, overallDirty.width, overallDirty.height);
              const isMono = colorMode === 'monochrome' || activeLayer?.expressionColor === 'monochrome';
              globalTileGrid.writeImageData(targetLayerId, subData, overallDirty.x, overallDirty.y, isMono ? 'monochrome-1bit' : 'color-32bit');
            }
          }
          globalTileGrid.notifyChange(true);
          if (!liquifyDirtyRectRef.current) {
            liquifyDirtyRectRef.current = overallDirty;
          } else {
            const cur = liquifyDirtyRectRef.current;
            const minX = Math.min(cur.x, overallDirty.x);
            const minY = Math.min(cur.y, overallDirty.y);
            const maxX = Math.max(cur.x + cur.width, overallDirty.x + overallDirty.width);
            const maxY = Math.max(cur.y + cur.height, overallDirty.y + overallDirty.height);
            liquifyDirtyRectRef.current = { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
          }
        }
        return;
      }

      const pt = getCanvasCoords(e);

      if ((tool === 'select-pen' || tool === 'select-eraser') && selectionPenDrawingRef.current?.isDrawing) {
        const { ctx: mCtx, lastPt } = selectionPenDrawingRef.current;
        const brushSize = brushSettings.size;
        mCtx.save();
        mCtx.lineCap = 'round';
        mCtx.lineJoin = 'round';
        mCtx.lineWidth = brushSize;
        if (tool === 'select-pen') {
          mCtx.globalCompositeOperation = 'source-over';
          mCtx.strokeStyle = '#ffffff';
        } else {
          mCtx.globalCompositeOperation = 'destination-out';
          mCtx.strokeStyle = '#000000';
        }

        mCtx.beginPath();
        mCtx.moveTo(lastPt.x, lastPt.y);
        mCtx.lineTo(pt.x, pt.y);
        mCtx.stroke();
        mCtx.restore();

        selectionPenDrawingRef.current.lastPt = pt;
        return;
      }

      if (selectionDragRef.current?.isDragging) {
        const dx = pt.x - selectionDragRef.current.startX;
        const dy = pt.y - selectionDragRef.current.startY;
        setSelection((prev) => {
          if (!prev || !prev.floating) return prev;
          const newX = Math.round(selectionDragRef.current!.origFloatingX + dx);
          const newY = Math.round(selectionDragRef.current!.origFloatingY + dy);
          const boundsX = Math.round(selectionDragRef.current!.origBoundsX + dx);
          const boundsY = Math.round(selectionDragRef.current!.origBoundsY + dy);
          let updatedPoly = prev.polygon;
          if (prev.type === 'lasso' && prev.polygon) {
            const shiftX = boundsX - prev.bounds.x;
            const shiftY = boundsY - prev.bounds.y;
            updatedPoly = prev.polygon.map((p) => ({ x: p.x + shiftX, y: p.y + shiftY }));
          }
          return {
            ...prev,
            bounds: { ...prev.bounds, x: boundsX, y: boundsY },
            polygon: updatedPoly,
            floating: {
              ...prev.floating,
              x: newX,
              y: newY,
            },
          };
        });
        return;
      }

      if (selectRectStartRef.current) {
        const s = selectRectStartRef.current;
        const minX = Math.floor(Math.min(s.x, pt.x));
        const minY = Math.floor(Math.min(s.y, pt.y));
        const w = Math.ceil(Math.abs(pt.x - s.x));
        const h = Math.ceil(Math.abs(pt.y - s.y));
        setSelection({
          type: 'rect',
          bounds: { x: minX, y: minY, width: w, height: h },
        });
        return;
      }

      if (lassoPointsRef.current.length > 0) {
        const pts = lassoPointsRef.current;
        const last = pts[pts.length - 1];
        if (Math.hypot(pt.x - last.x, pt.y - last.y) >= 2) {
          pts.push(pt);
          const b = computePolygonBounds(pts);
          setSelection({
            type: 'lasso',
            bounds: b,
            polygon: [...pts],
          });
        }
        return;
      }

      if (tool === 'fill' && fillSettings.method === 'lasso' && lassoFillPointsRef.current.length > 0) {
        lassoFillPointsRef.current.push(pt);
        return;
      }
    },
    [
      tool,
      activeLayer,
      activeLayerId,
      colorMode,
      vectorEditSettings,
      getActiveCanvas,
      updateLayerThumbnail,
      layerSourceCanvasesRef,
      layerCanvasesRef,
      handleCanvasDrawingPointerMove,
      getCanvasCoords,
      fillSettings.method,
      handleSampleColor,
      brushSettings.size,
      dimensions,
    ]
  );

  const handlePointerUp = useCallback(
    (e: React.PointerEvent<HTMLElement>) => {
      if (tool === 'pipette') {
        try {
          (e.target as HTMLElement).releasePointerCapture(e.pointerId);
        } catch {}
        if (isPipetteSamplingRef.current) {
          isPipetteSamplingRef.current = false;
          const pt = getCanvasCoords(e);
          handleSampleColor(pt);
        }
        return;
      }

      if (tool === 'brush' || tool === 'eraser') {
        handleCanvasDrawingPointerUp(e);
        return;
      }

      if (tool === 'liquify') {
        try {
          (e.target as HTMLElement).releasePointerCapture(e.pointerId);
        } catch {}

        if (liquifyRafIdRef.current) {
          cancelAnimationFrame(liquifyRafIdRef.current);
          liquifyRafIdRef.current = null;
        }

        if (isLiquifyingRef.current) {
          isLiquifyingRef.current = false;
          const targetLayerId = activeLayerId;
          const isTone = Boolean(activeLayer?.toneEnabled && layerSourceCanvasesRef.current?.get(targetLayerId));
          const sourceCanvas = layerSourceCanvasesRef.current?.get(targetLayerId);
          const displayCanvas = layerCanvasesRef.current.get(targetLayerId);
          const canvas = (isTone && sourceCanvas) ? sourceCanvas : displayCanvas;

          if (canvas && liquifyBeforeImageDataRef.current) {
            const ctx = get2DContext(canvas);
            const afterImageData = ctx?.getImageData(0, 0, canvas.width, canvas.height);
            if (afterImageData) {
              const modeLabel = liquifySettingsRef.current.mode.charAt(0).toUpperCase() + liquifySettingsRef.current.mode.slice(1);
              pushHistoryStep(
                'liquify',
                `Liquify: ${modeLabel}`,
                liquifyBeforeImageDataRef.current,
                afterImageData,
                targetLayerId
              );
              globalTileGrid.notifyChange(true);
              updateLayerThumbnail(targetLayerId, true);
            }
          }

          liquifyBeforeImageDataRef.current = null;
          liquifyInitialImageDataRef.current = null;
          liquifySelectionMaskRef.current = null;
          liquifyDirtyRectRef.current = null;
          prevLiquifyPointRef.current = null;
          liquifyLastPointerPosRef.current = null;
        }
        return;
      }

      const pt = getCanvasCoords(e);

      if ((tool === 'select-pen' || tool === 'select-eraser') && selectionPenDrawingRef.current?.isDrawing) {
        const { ctx: mCtx } = selectionPenDrawingRef.current;
        selectionPenDrawingRef.current = null;
        const w = dimensions.width;
        const h = dimensions.height;
        const mImgData = mCtx.getImageData(0, 0, w, h);
        const newMask = new Uint8Array(w * h);
        for (let i = 0; i < newMask.length; i++) {
          newMask[i] = mImgData.data[i * 4 + 3] > 0 ? 255 : 0;
        }
        const b = maskToBounds(newMask, w, h);
        if (b) {
          const svg = maskToSvgPath(newMask, w, h);
          setSelection({
            type: 'mask',
            bounds: b,
            mask: newMask,
            maskWidth: w,
            maskHeight: h,
            svgPath: svg,
          });
        } else {
          setSelection(null);
        }
        return;
      }

      if (selectionDragRef.current?.isDragging) {
        selectionDragRef.current = null;
        return;
      }

      if (selectRectStartRef.current) {
        const s = selectRectStartRef.current;
        selectRectStartRef.current = null;
        const minX = Math.floor(Math.min(s.x, pt.x));
        const minY = Math.floor(Math.min(s.y, pt.y));
        const w = Math.ceil(Math.abs(pt.x - s.x));
        const h = Math.ceil(Math.abs(pt.y - s.y));
        if (w < 4 || h < 4) {
          setSelection(null);
        } else {
          setSelection({
            type: 'rect',
            bounds: { x: minX, y: minY, width: w, height: h },
          });
        }
        return;
      }

      if (lassoPointsRef.current.length > 0) {
        if (lassoPointsRef.current.length < 3) {
          setSelection(null);
        } else {
          const b = computePolygonBounds(lassoPointsRef.current);
          setSelection({
            type: 'lasso',
            bounds: b,
            polygon: [...lassoPointsRef.current],
          });
        }
        lassoPointsRef.current = [];
        return;
      }

      if (tool === 'fill' && fillSettings.method === 'lasso' && lassoFillPointsRef.current.length >= 3) {
        const pts = [...lassoFillPointsRef.current];
        lassoFillPointsRef.current = [];
        const canvas = getActiveCanvas();
        if (!canvas) return;
        const ctx = get2DContext(canvas);
        if (!ctx) return;
        const beforeImageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
        const sourceCanvas = layerSourceCanvasesRef.current?.get(activeLayerId);

        executeLassoFill(canvas, pts, primaryColor, sourceCanvas);
        if (activeLayer?.toneEnabled && sourceCanvas) {
          applyLayerEffects(sourceCanvas, canvas, activeLayer, dimensions.dpi ?? 600);
        }

        const afterImageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
        updateLayerThumbnail(activeLayerId, true);
        pushHistoryStep(
          'fill',
          'Lasso Fill',
          beforeImageData,
          afterImageData,
          activeLayerId
        );
        globalTileGrid.notifyChange(true);
        return;
      }

      if (tool === 'frame' && frameStartRef.current) {
        const s = frameStartRef.current;
        frameStartRef.current = null;
        const minX = Math.floor(Math.min(s.x, pt.x));
        const minY = Math.floor(Math.min(s.y, pt.y));
        const w = Math.ceil(Math.abs(pt.x - s.x));
        const h = Math.ceil(Math.abs(pt.y - s.y));

        if (w >= 4 && h >= 4) {
          const canvas = getActiveCanvas();
          if (!canvas) return;
          const ctx = get2DContext(canvas);
          if (!ctx) return;
          const beforeImageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
          const sourceCanvas = layerSourceCanvasesRef.current?.get(activeLayerId);

          const drawFrameOn = (target: HTMLCanvasElement) => {
            const c = get2DContext(target);
            if (!c) return;
            c.save();
            if (frameSettings.fillBackground) {
              c.fillStyle = frameSettings.fillColor || '#ffffff';
              c.fillRect(minX, minY, w, h);
            }
            c.strokeStyle = primaryColor || '#000000';
            c.lineWidth = frameSettings.thickness;
            c.lineJoin = 'miter';
            c.strokeRect(minX, minY, w, h);
            c.restore();
          };

          drawFrameOn(canvas);
          if (sourceCanvas) drawFrameOn(sourceCanvas);

          const afterImageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
          updateLayerThumbnail(activeLayerId, true);
          pushHistoryStep(
            'frame',
            'Frame Border',
            beforeImageData,
            afterImageData,
            activeLayerId
          );
          globalTileGrid.notifyChange(true);
        }
        return;
      }

      if (tool === 'vector-edit' && isVectorEditingRef.current) {
        isVectorEditingRef.current = false;
        if (activeLayer?.vectorStrokes && vectorEditBeforeStrokesRef.current) {
          pushHistoryStep(
            'brush',
            `Correct Line (${vectorEditSettings.mode})`,
            null,
            null,
            activeLayerId,
            undefined,
            undefined,
            { before: vectorEditBeforeStrokesRef.current, after: [...activeLayer.vectorStrokes] }
          );
          globalTileGrid.notifyChange(true);
        }
        return;
      }
    },
    [
      tool,
      activeLayer,
      activeLayerId,
      vectorEditSettings,
      layerCanvasesRef,
      handleCanvasDrawingPointerUp,
      getCanvasCoords,
      selection,
      fillSettings.method,
      getActiveCanvas,
      layerSourceCanvasesRef,
      primaryColor,
      updateLayerThumbnail,
      pushHistoryStep,
      frameSettings,
      handleSampleColor,
      dimensions,
    ]
  );

  const needsAdaptiveFitRef = useRef<boolean>(true);
  const pendingFitDimsRef = useRef<CanvasDimensions | null>(null);

  const handleViewportReady = useCallback(
    (_viewport: HTMLDivElement) => {
      if (needsAdaptiveFitRef.current) {
        if (_viewport.clientWidth <= 0 || _viewport.clientHeight <= 0) {
          return;
        }
        needsAdaptiveFitRef.current = false;
        const targetDims = pendingFitDimsRef.current || dimensions;
        pendingFitDimsRef.current = null;
        resetZoomAndCenter(targetDims);
      }
    },
    [dimensions, resetZoomAndCenter]
  );

  // Create New Canvas handler
  const handleCreateNewCanvas = useCallback(
    (options: NewCanvasOptions) => {
      const newDims: CanvasDimensions = {
        width: options.width,
        height: options.height,
        dpi: options.dpi,
      };
      setDimensions(newDims);
      setColorMode(options.colorMode);
      let name = (options.name || 'Untitled').trim();
      if (!/\.[a-zA-Z0-9]+$/.test(name) && !name.endsWith('*')) {
        name = `${name}*`;
      }
      setDocumentName(name);
      setSavedFileInfo(null); // Reset saved file state on new canvas

      // Snap brush color if switching to monochrome or grayscale
      if (options.colorMode === 'monochrome') {
        const snapPrimary = enforceColorMode(primaryColor, 'monochrome');
        setPrimaryColor(snapPrimary);
        updateBrushSettings({ color: snapPrimary, hardness: 1.0 });
      } else if (options.colorMode === 'grayscale') {
        const snapPrimary = enforceColorMode(primaryColor, 'grayscale');
        setPrimaryColor(snapPrimary);
        updateBrushSettings({ color: snapPrimary });
      }

      const defaultFreq = options.defaultFrequency ?? 60;
      const { layers: initialLayers, activeLayerId: topId } = resetToNewCanvas(
        newDims,
        options.backgroundColor,
        options.colorMode,
        defaultFreq
      );
      needsAdaptiveFitRef.current = true;
      pendingFitDimsRef.current = newDims;
      resetZoomAndCenter(newDims);
      resetHistory();

      // Add to document tabs (empty perspective ruler by default)
      const newDocId = `doc-${Date.now()}`;
      const newDoc: DocumentTab = {
        id: newDocId,
        name,
        dimensions: newDims,
        colorMode: options.colorMode,
        layers: initialLayers,
        activeLayerId: topId,
        perspectiveRuler: null,
        defaultFrequency: defaultFreq,
      };

      setPerspectiveRuler(null);
      setDocuments((prev) => [...prev, newDoc]);
      setActiveDocumentId(newDocId);
      setAppView('workspace');

      showToast(`Created ${name}`);
    },
    [primaryColor, resetHistory, resetToNewCanvas, resetZoomAndCenter, showToast, updateBrushSettings]
  );

  // Initialize a default white canvas on launch so >80% of the viewport is immediately dedicated to drawing
  const hasAutoCreatedInitialDocRef = useRef(false);
  useEffect(() => {
    if (hasAutoCreatedInitialDocRef.current || documents.length > 0) return;
    hasAutoCreatedInitialDocRef.current = true;
    const initDims: CanvasDimensions = {
      width: appSettings.defaultWidth || 1920,
      height: appSettings.defaultHeight || 1080,
      dpi: appSettings.defaultDpi || 300,
    };
    const initColorMode = appSettings.defaultColorMode || 'color';
    const initBg = appSettings.defaultBgColor || '#ffffff';
    const initName = 'Untitled*';
    setDimensions(initDims);
    setColorMode(initColorMode);
    setDocumentName(initName);
    const { layers: initialLayers, activeLayerId: topId } = resetToNewCanvas(
      initDims,
      initBg,
      initColorMode,
      60
    );
    needsAdaptiveFitRef.current = true;
    pendingFitDimsRef.current = initDims;
    resetZoomAndCenter(initDims);
    resetHistory();
    const newDocId = `doc-${Date.now()}`;
    setDocuments([
      {
        id: newDocId,
        name: initName,
        dimensions: initDims,
        colorMode: initColorMode,
        layers: initialLayers,
        activeLayerId: topId,
        perspectiveRuler: null,
        defaultFrequency: 60,
      },
    ]);
    setActiveDocumentId(newDocId);
    setAppView('workspace');
  }, [
    appSettings.defaultBgColor,
    appSettings.defaultColorMode,
    appSettings.defaultDpi,
    appSettings.defaultHeight,
    appSettings.defaultWidth,
    documents.length,
    resetHistory,
    resetToNewCanvas,
    resetZoomAndCenter,
  ]);

  // Copy selected layer
  const handleCopySelectedLayer = useCallback(() => {
    if (!activeLayer) return;
    const copied = copyLayer(activeLayerId);
    if (copied) {
      showToast(`Copied layer "${copied.name}"`);
    }
  }, [activeLayer, activeLayerId, copyLayer, showToast]);

  // Paste layer
  const handlePasteSelectedLayer = useCallback(async () => {
    const res = await pasteLayer();
    if (res.success && res.layerName) {
      showToast(`Pasted layer "${res.layerName}"`);
    } else {
      showToast('Clipboard is empty');
    }
  }, [pasteLayer, showToast]);

  // Delete selected layer
  const handleDeleteSelectedLayer = useCallback(() => {
    const rasterCount = layers.filter((l) => l.type === 'raster').length;
    if (rasterCount <= 1) {
      showToast('Cannot delete the only raster layer');
      return;
    }
    const layerName = activeLayer?.name || 'layer';
    deleteLayer(activeLayerId);
    showToast(`Deleted layer "${layerName}"`);
  }, [activeLayer, activeLayerId, deleteLayer, layers, showToast]);

  // Paste from file
  const handleTriggerPasteFromFile = useCallback(() => {
    pasteFileInputRef.current?.click();
  }, []);

  const handlePasteFileInputChange = useCallback(
    async (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (file) {
        try {
          const layerName = await pasteLayerFromFile(file);
          showToast(`Pasted "${layerName}" from file`);
        } catch (err: unknown) {
          console.error('Failed to paste from file:', err);
          const errMsg = err instanceof Error ? err.message : String(err);
          alert(`Failed to paste image from file: ${errMsg}`);
        } finally {
          if (pasteFileInputRef.current) {
            pasteFileInputRef.current.value = '';
          }
        }
      }
    },
    [pasteLayerFromFile, showToast]
  );

  // Import 3D Model File (.glb, .gltf, .obj)
  const handleTriggerImport3DFile = useCallback(() => {
    import3DFileInputRef.current?.click();
  }, []);

  const handleImport3DFileInputChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (file) {
        setInitial3DFile(file);
        setIs3DLayerOpen(true);
        showToast(`Importing 3D model "${file.name}" into local ghost layer...`);
        if (import3DFileInputRef.current) {
          import3DFileInputRef.current.value = '';
        }
      }
    },
    [showToast]
  );

  // Resize canvas
  const handleResizeCanvas = useCallback(
    (options: ResizeCanvasOptions) => {
      const newDims: CanvasDimensions = {
        width: options.width,
        height: options.height,
        dpi: options.dpi || dimensions.dpi,
      };

      resizeCanvas(newDims, options);
      setDimensions(newDims);
      pendingFitDimsRef.current = newDims;
      needsAdaptiveFitRef.current = true;
      resetZoomAndCenter(newDims);
      resetHistory();
      showToast(`Canvas resized to ${newDims.width} × ${newDims.height} px`);
    },
    [dimensions.dpi, resetHistory, resetZoomAndCenter, resizeCanvas, showToast]
  );

  // Settings update handler
  const handleUpdateSettings = useCallback((newSettings: AppSettings) => {
    setAppSettings(newSettings);
    saveAppSettings(newSettings);
    globalTileMemoryManager.setBudgetMb(newSettings.tileMemoryBudgetMb || 1024);
    setBrushSettings((prev) => ({
      ...prev,
      stabilization: newSettings.defaultStabilization,
      usePressure: newSettings.usePressureByDefault,
      smoothing: newSettings.smoothingEnabled,
    }));
  }, []);

  // Synchronize initial tile memory budget
  useEffect(() => {
    globalTileMemoryManager.setBudgetMb(appSettings.tileMemoryBudgetMb || 1024);
  }, [appSettings.tileMemoryBudgetMb]);

  // File loading handler
  const handleProcessFile = useCallback(
    async (file: File) => {
      if (file.name.toLowerCase().endsWith('.sut')) {
        try {
          setIsLoadingFile(true);
          setLoadingStatus(`Importing CSP Brush: ${file.name}...`);
          const buffer = await file.arrayBuffer();
          const parsedBrush = await parseSutFile(buffer, file.name);
          const existing = (await loadCustomBrushes()).filter(
            (b) => b.name.toLowerCase() === parsedBrush.name.toLowerCase() || b.id === parsedBrush.id
          );
          for (const old of existing) {
            await deleteCustomBrush(old.id).catch(() => {});
          }
          await saveCustomBrush(parsedBrush);
          setTool('brush');
          const fullSettings = await prepareBrushSettingsForCsp(parsedBrush);
          updateBrushSettings(fullSettings);
          showToast(`Imported CSP brush "${parsedBrush.name}" successfully!`);
        } catch (err: any) {
          showToast(err.message || 'Failed to import .sut brush.');
        } finally {
          setIsLoadingFile(false);
          setLoadingStatus('');
          if (fileInputRef.current) {
            fileInputRef.current.value = '';
          }
        }
        return;
      }

      try {
        setIsLoadingFile(true);
        setLoadingStatus(`Loading ${file.name}...`);

        const doc = await openFile(file);
        setDimensions(doc.dimensions);
        setColorMode(doc.colorMode);
        setDocumentName(doc.name);
        setSavedFileInfo(null); // Reset handle on new import

        loadDocument(doc);
        needsAdaptiveFitRef.current = true;
        pendingFitDimsRef.current = doc.dimensions;
        resetZoomAndCenter(doc.dimensions);
        resetHistory();

        // Create document tab
        const newDocId = `doc-${Date.now()}`;
        const newDoc: DocumentTab = {
          id: newDocId,
          name: doc.name,
          dimensions: doc.dimensions,
          colorMode: doc.colorMode,
          layers: doc.layers,
          activeLayerId: doc.layers[0]?.id || 'layer-1',
          perspectiveRuler: null,
        };

        setPerspectiveRuler(null);
        setDocuments((prev) => [...prev, newDoc]);
        setActiveDocumentId(newDocId);

        // Track in recent documents
        saveRecentDocument({
          id: newDocId,
          title: file.name,
          path: (file as any).path || `C:\\Users\\Artist\\Documents\\InkStudio\\${file.name}`,
          size: file.size || 1048576,
          coverUrl: doc.layers[0]?.thumbnailUrl,
          isStarred: false,
          fileType: file.name.slice(file.name.lastIndexOf('.')),
          isSaved: true,
        }).catch(console.warn);

        showToast(`Opened ${file.name}`);
      } catch (err: unknown) {
        console.error('Failed to open file:', err);
        const errMsg = err instanceof Error ? err.message : String(err);
        alert(`Could not open "${file.name}":\n${errMsg || 'Unsupported or corrupted file.'}`);
      } finally {
        setIsLoadingFile(false);
        setLoadingStatus('');
        if (fileInputRef.current) {
          fileInputRef.current.value = '';
        }
      }
    },
    [loadDocument, resetHistory, resetZoomAndCenter, showToast]
  );

  // Keep active document tab's layers in sync
  useEffect(() => {
    if (!activeDocumentId) return;
    setDocuments((prev) => {
      const curr = prev.find((d) => d.id === activeDocumentId);
      if (!curr) return prev;
      if (
        curr.layers === layers &&
        curr.activeLayerId === activeLayerId &&
        curr.layerCanvasesMap &&
        curr.layerCanvasesMap.size === layerCanvasesRef.current.size
      ) {
        return prev;
      }
      return prev.map((d) =>
        d.id === activeDocumentId
          ? {
              ...d,
              layers,
              activeLayerId,
              layerCanvasesMap: new Map(layerCanvasesRef.current),
            }
          : d
      );
    });
  }, [layers, activeLayerId, activeDocumentId, layerCanvasesRef]);

  // Tab selection, close, and rename handlers
  const handleSelectDocument = useCallback(
    (id: string) => {
      const doc = documents.find((d) => d.id === id);
      if (!doc) return;
      setActiveDocumentId(id);
      setAppView('workspace');
      setDimensions(doc.dimensions);
      setColorMode(doc.colorMode);
      setDocumentName(doc.name);
      if (doc.defaultFrequency) {
        setDefaultToneFrequency(doc.defaultFrequency);
      }
      if (doc.savedFileInfo && doc.savedFileInfo.extension) {
        setSavedFileInfo({
          name: doc.savedFileInfo.name,
          handle: doc.savedFileInfo.handle,
          extension: doc.savedFileInfo.extension,
        });
      } else {
        setSavedFileInfo(null);
      }
      if (doc.layers && doc.layers.length > 0) {
        loadDocument({
          dimensions: doc.dimensions,
          colorMode: doc.colorMode,
          name: doc.name,
          layers: doc.layers,
          layerCanvases: doc.layerCanvasesMap,
        });
      }
      setPerspectiveRuler(doc.perspectiveRuler ?? null);
      needsAdaptiveFitRef.current = true;
      pendingFitDimsRef.current = doc.dimensions;
      resetZoomAndCenter(doc.dimensions);
    },
    [documents, loadDocument, resetZoomAndCenter]
  );

  const handleCloseDocument = useCallback(
    (id: string) => {
      setDocuments((prev) => {
        const next = prev.filter((d) => d.id !== id);
        if (id === activeDocumentId) {
          if (next.length > 0) {
            const nextActive = next[next.length - 1];
            setActiveDocumentId(nextActive.id);
            setDimensions(nextActive.dimensions);
            setColorMode(nextActive.colorMode);
            setDocumentName(nextActive.name);
            setPerspectiveRuler(nextActive.perspectiveRuler ?? null);
            if (nextActive.savedFileInfo && nextActive.savedFileInfo.extension) {
              setSavedFileInfo({
                name: nextActive.savedFileInfo.name,
                handle: nextActive.savedFileInfo.handle,
                extension: nextActive.savedFileInfo.extension,
              });
            } else {
              setSavedFileInfo(null);
            }
            if (nextActive.layers && nextActive.layers.length > 0) {
              loadDocument({
                dimensions: nextActive.dimensions,
                colorMode: nextActive.colorMode,
                name: nextActive.name,
                layers: nextActive.layers,
                layerCanvases: nextActive.layerCanvasesMap,
              });
              needsAdaptiveFitRef.current = true;
              pendingFitDimsRef.current = nextActive.dimensions;
              resetZoomAndCenter(nextActive.dimensions);
            } else {
              clearDocument();
            }
          } else {
            setActiveDocumentId(null);
            setDocumentName('');
            setSavedFileInfo(null);
            clearDocument();
            resetHistory();
            setPerspectiveRuler(null);
            setAppView('home');
          }
        }
        return next;
      });
      if (id) {
        recoveryService.closeSession(id).catch(console.warn);
      }
    },
    [activeDocumentId, clearDocument, loadDocument, resetHistory]
  );

  // Fault-Tolerant Crash Recovery Restore Handler
  const handleRestoreCrashedSession = useCallback(
    async (session: CrashedSessionInfo) => {
      try {
        const replayData = await recoveryService.loadSessionData(session.session_id);
        const { manifest, replayedStrokesCount, replayedMutationsCount } =
          recoveryService.replaySessionData(replayData, globalTileGrid);

        const restoredDims: CanvasDimensions = {
          width: manifest.width,
          height: manifest.height,
          dpi: manifest.dpi,
        };

        // Reconstruct layer canvases backing buffers
        const restoredLayerCanvases = new Map<string, HTMLCanvasElement>();
        for (const layer of manifest.layers) {
          if (layer.type === 'raster' || layer.type === 'vector' || layer.type === 'frame') {
            const canvas = document.createElement('canvas');
            canvas.width = restoredDims.width;
            canvas.height = restoredDims.height;
            globalTileGrid.renderLayerToCanvas(layer.id, canvas);
            restoredLayerCanvases.set(layer.id, canvas);
          }
        }

        // Load document into useLayerManager
        loadDocument({
          name: manifest.documentName,
          dimensions: restoredDims,
          colorMode: manifest.colorMode,
          layers: manifest.layers,
          layerCanvases: restoredLayerCanvases,
        });
        if (manifest.activeLayerId) {
          setActiveLayerId(manifest.activeLayerId);
        }

        // Set dimensions & color mode
        setDimensions(restoredDims);
        setColorMode(manifest.colorMode);
        setDocumentName(manifest.documentName);

        const restoredDoc: DocumentTab = {
          id: session.session_id,
          name: manifest.documentName,
          dimensions: restoredDims,
          colorMode: manifest.colorMode,
          layers: manifest.layers,
          activeLayerId: manifest.activeLayerId || manifest.layers[0]?.id || '',
          layerCanvasesMap: restoredLayerCanvases,
        };

        setDocuments((prev) => {
          const filtered = prev.filter((d) => d.id !== session.session_id);
          return [restoredDoc, ...filtered];
        });
        setActiveDocumentId(session.session_id);
        setAppView('workspace');

        needsAdaptiveFitRef.current = true;
        pendingFitDimsRef.current = restoredDims;
        resetZoomAndCenter(restoredDims);
        resetHistory();

        // Push undo history entry
        pushHistoryStep(
          'initial',
          'Session restored from crash',
          null,
          null,
          manifest.activeLayerId || manifest.layers[0]?.id || ''
        );

        // Invalidate GPU textures & trigger compositor
        globalTileGrid.notifyChange(true);

        setIsRecoveryModalOpen(false);
        setCrashedSessions((prev) => prev.filter((s) => s.session_id !== session.session_id));
        showToast(
          `Restored "${manifest.documentName}" (${replayedStrokesCount} strokes, ${replayedMutationsCount} mutations recovered)`
        );
      } catch (err: any) {
        console.error('[Recovery] Restore error:', err);
        alert('Failed to restore crashed session: ' + err.message);
      }
    },
    [loadDocument, resetHistory, resetZoomAndCenter, showToast, pushHistoryStep, setActiveLayerId]
  );

  const handleDiscardCrashedSession = useCallback(
    async (session: CrashedSessionInfo) => {
      try {
        await recoveryService.discardCrashedSession(session.session_id);
        setCrashedSessions((prev) => {
          const next = prev.filter((s) => s.session_id !== session.session_id);
          if (next.length === 0) {
            setIsRecoveryModalOpen(false);
          }
          return next;
        });
        showToast('Crashed session discarded');
      } catch (err: any) {
        console.warn('[Recovery] Discard error:', err);
      }
    },
    [showToast]
  );

  const handleRenameDocument = useCallback(
    (id: string, newName: string) => {
      setDocuments((prev) =>
        prev.map((d) => (d.id === id ? { ...d, name: newName } : d))
      );
      if (id === activeDocumentId) {
        setDocumentName(newName);
      }
    },
    [activeDocumentId]
  );

  const handleTriggerOpenFile = useCallback(() => {
    fileInputRef.current?.click();
  }, []);

  const handleFileInputChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (file) {
        handleProcessFile(file);
      }
    },
    [handleProcessFile]
  );

  // 1. Save (Ctrl+S) - Prompts if not saved yet; otherwise saves directly
  const handleSave = useCallback(async () => {
    const cleanNameForSave = documentName.replace(/\*+$/, '') || 'Untitled';
    const docData: SaveDocumentData = {
      name: cleanNameForSave,
      dimensions,
      colorMode,
      layers,
      layerCanvasesMap: layerCanvasesRef.current,
      getEffectiveOpacity,
      isLayerEffectivelyVisible,
      tabId: activeDocumentId || undefined,
    };

    // If haven't saved the file yet, prompt to select a path and file extension
    if (!savedFileInfo?.handle) {
      try {
        const info = await promptSaveAs(docData, savedFileInfo?.extension || '.sora');
        setSavedFileInfo(info);
        // info.name includes the extension (e.g. art.sora or Untitled.sora)
        setDocumentName(info.name);
        setDocuments((prev) =>
          prev.map((d) => (d.id === activeDocumentId ? { ...d, name: info.name, savedFileInfo: info } : d))
        );
        saveRecentDocument({
          id: activeDocumentId || `doc-${Date.now()}`,
          title: info.name,
          path: `InkStudio\\${info.name}`,
          size: 1572864,
          coverUrl: layers[0]?.thumbnailUrl,
          isStarred: false,
          fileType: info.extension,
          isSaved: true,
        }).catch(console.warn);
        showToast(`Saved to ${info.name}`);
      } catch (err: any) {
        if (err.message !== 'Save canceled') {
          alert('Failed to save file: ' + err.message);
        }
      }
    } else {
      // File has already been saved before: directly write without prompting!
      try {
        await saveToExistingHandle(docData, savedFileInfo);
        setDocumentName(savedFileInfo.name);
        setDocuments((prev) =>
          prev.map((d) => (d.id === activeDocumentId ? { ...d, name: savedFileInfo.name } : d))
        );
        saveRecentDocument({
          id: activeDocumentId || `doc-${Date.now()}`,
          title: savedFileInfo.name,
          path: `InkStudio\\${savedFileInfo.name}`,
          size: 1572864,
          coverUrl: layers[0]?.thumbnailUrl,
          isStarred: false,
          fileType: savedFileInfo.extension,
          isSaved: true,
        }).catch(console.warn);
        showToast(`Saved to ${savedFileInfo.name}`);
      } catch (err: any) {
        console.warn('Direct handle save failed, prompting with Save As:', err);
        try {
          const info = await promptSaveAs(docData, savedFileInfo.extension || '.sora');
          setSavedFileInfo(info);
          setDocumentName(info.name);
          setDocuments((prev) =>
            prev.map((d) => (d.id === activeDocumentId ? { ...d, name: info.name, savedFileInfo: info } : d))
          );
          saveRecentDocument({
            id: activeDocumentId || `doc-${Date.now()}`,
            title: info.name,
            path: `InkStudio\\${info.name}`,
            size: 1572864,
            coverUrl: layers[0]?.thumbnailUrl,
            isStarred: false,
            fileType: info.extension,
            isSaved: true,
          }).catch(console.warn);
          showToast(`Saved to ${info.name}`);
        } catch (e: any) {
          if (e.message !== 'Save canceled') {
            alert('Failed to save file: ' + e.message);
          }
        }
      }
    }
  }, [
    activeDocumentId,
    colorMode,
    dimensions,
    documentName,
    getEffectiveOpacity,
    isLayerEffectivelyVisible,
    layerCanvasesRef,
    layers,
    savedFileInfo,
    showToast,
  ]);

  // 2. Save As (Ctrl+Shift+S) - Always prompts to select path and extension
  const handleSaveAs = useCallback(async () => {
    const cleanNameForSave = documentName.replace(/\*+$/, '') || 'Untitled';
    const docData: SaveDocumentData = {
      name: cleanNameForSave,
      dimensions,
      colorMode,
      layers,
      layerCanvasesMap: layerCanvasesRef.current,
      getEffectiveOpacity,
      isLayerEffectivelyVisible,
      tabId: activeDocumentId || undefined,
    };

    try {
      const defaultExt = savedFileInfo?.extension || '.sora';
      const info = await promptSaveAs(docData, defaultExt);
      setSavedFileInfo(info);
      setDocumentName(info.name);
      setDocuments((prev) =>
        prev.map((d) => (d.id === activeDocumentId ? { ...d, name: info.name, savedFileInfo: info } : d))
      );
      saveRecentDocument({
        id: activeDocumentId || `doc-${Date.now()}`,
        title: info.name,
        path: `InkStudio\\${info.name}`,
        size: 1572864,
        coverUrl: layers[0]?.thumbnailUrl,
        isStarred: false,
        fileType: info.extension,
        isSaved: true,
      }).catch(console.warn);
      showToast(`Saved as ${info.name}`);
    } catch (err: any) {
      if (err.message !== 'Save canceled') {
        alert('Failed to save file: ' + err.message);
      }
    }
  }, [
    activeDocumentId,
    colorMode,
    dimensions,
    documentName,
    getEffectiveOpacity,
    isLayerEffectivelyVisible,
    layerCanvasesRef,
    layers,
    savedFileInfo,
    showToast,
  ]);

  // 3. Export Image - Export as .png; always prompts for a download path within a folder
  const handleExportImage = useCallback(async () => {
    const cleanNameForSave = documentName.replace(/\*+$/, '') || 'Untitled';
    const docData: SaveDocumentData = {
      name: cleanNameForSave,
      dimensions,
      colorMode,
      layers,
      layerCanvasesMap: layerCanvasesRef.current,
      getEffectiveOpacity,
      isLayerEffectivelyVisible,
    };

    try {
      const exportedName = await promptExportPngImage(docData, cleanNameForSave);
      showToast(`Exported image to ${exportedName}`);
    } catch (err: any) {
      if (err.message !== 'Export canceled') {
        alert('Failed to export image: ' + err.message);
      }
    }
  }, [
    colorMode,
    dimensions,
    documentName,
    getEffectiveOpacity,
    isLayerEffectivelyVisible,
    layerCanvasesRef,
    layers,
    showToast,
  ]);

  const isAnyModalOpen =
    isRecoveryModalOpen ||
    isNewCanvasModalOpen ||
    isResizeCanvasModalOpen ||
    isSettingsModalOpen ||
    tonalModalState.isOpen ||
    adjustmentModalState.isOpen ||
    layerStylesModalState.isOpen ||
    isToneModalOpen ||
    isHostModalOpen ||
    isMangaEffectsModalOpen ||
    isWebtoonExportModalOpen ||
    isLoadingFile;

  const isAnyModalOpenRef = useRef<boolean>(isAnyModalOpen);
  isAnyModalOpenRef.current = isAnyModalOpen;

  const tempToolHoldRef = useRef<{
    code: string;
    prevTool: ToolType;
    targetTool: ToolType;
    downAt: number;
    usedWhileHeld: boolean;
  } | null>(null);

  const handleResetDefaultColors = useCallback(() => {
    setIsTransparentColor(false);
    const prim = enforceColorMode('#000000', colorMode);
    const sec = enforceColorMode('#ffffff', colorMode);
    setPrimaryColor(prim);
    setSecondaryColor(sec);
    updateBrushSettings({ color: prim, secondaryColor: sec, isTransparentInk: false });
  }, [colorMode, updateBrushSettings]);

  // Global Keyboard Shortcuts (Layout-Independent e.code + CSP Hold-and-Release Temporary Tools)
  useEffect(() => {
    const isEditableTarget = (target: EventTarget | null): boolean => {
      if (!(target instanceof HTMLElement)) return false;
      const tag = target.tagName;
      return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target.isContentEditable;
    };

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

    const handleKeyDown = (e: KeyboardEvent) => {
      if (isAnyModalOpenRef.current || isEditableTarget(e.target)) {
        return;
      }

      const key = e.key.toLowerCase();
      const code = e.code;

      // Ctrl / Cmd shortcuts
      if (e.ctrlKey || e.metaKey) {
        // Toggle Animation Timeline: Ctrl+Alt+A
        if (e.altKey && !e.shiftKey && (code === 'KeyA' || key === 'a')) {
          if (!hasOpenDocument) return;
          e.preventDefault();
          if (activeAnimationTimeline) {
            handleUpdateAnimationTimeline(null);
          } else {
            handleUpdateAnimationTimeline(createDefaultAnimationTimeline(layers));
          }
          return;
        }

        // Soft Proof Colors: Ctrl+Alt+Y
        if (e.altKey && !e.shiftKey && (code === 'KeyY' || key === 'y')) {
          if (!hasOpenDocument) return;
          e.preventDefault();
          toggleSoftProof();
          return;
        }

        // Ignore other Ctrl+Alt combinations (reserved for Ctrl+Alt+Drag resize & Ctrl+Alt+0 reset rotation)
        if (e.altKey) return;

        // Undo: Ctrl+Z (Cmd+Z)
        if (!e.shiftKey && (code === 'KeyZ' || key === 'z')) {
          if (!hasOpenDocument) return;
          e.preventDefault();
          handleUndo();
          return;
        }
        // Redo: Ctrl+Shift+Z or Ctrl+Y
        if (
          (e.shiftKey && (code === 'KeyZ' || key === 'z')) ||
          (!e.shiftKey && (code === 'KeyY' || key === 'y'))
        ) {
          if (!hasOpenDocument) return;
          e.preventDefault();
          redo();
          return;
        }
        // Gamut Warning: Ctrl+Shift+Y
        if (e.shiftKey && (code === 'KeyY' || key === 'y')) {
          if (!hasOpenDocument) return;
          e.preventDefault();
          toggleGamutWarning();
          return;
        }
        // New Raster Layer: Ctrl+Shift+N
        if (e.shiftKey && (code === 'KeyN' || key === 'n')) {
          if (!hasOpenDocument) return;
          e.preventDefault();
          handleAddLayer('raster');
          return;
        }
        // New Canvas: Ctrl+N
        if (!e.shiftKey && (code === 'KeyN' || key === 'n')) {
          e.preventDefault();
          setIsNewCanvasModalOpen(true);
          return;
        }
        // Open File: Ctrl+O
        if (!e.shiftKey && (code === 'KeyO' || key === 'o')) {
          e.preventDefault();
          handleTriggerOpenFile();
          return;
        }
        // Save As: Ctrl+Shift+S
        if (e.shiftKey && (code === 'KeyS' || key === 's')) {
          if (!hasOpenDocument) return;
          e.preventDefault();
          handleSaveAs();
          return;
        }
        // Save: Ctrl+S
        if (!e.shiftKey && (code === 'KeyS' || key === 's')) {
          if (!hasOpenDocument) return;
          e.preventDefault();
          handleSave();
          return;
        }
        // Duplicate Layer: Ctrl+J
        if (!e.shiftKey && (code === 'KeyJ' || key === 'j')) {
          if (!hasOpenDocument || !activeLayer) return;
          e.preventDefault();
          duplicateLayer(activeLayerId);
          return;
        }
        // Copy Layer: Ctrl+C (only when no text is selected)
        if (!e.shiftKey && (code === 'KeyC' || key === 'c')) {
          if (!hasOpenDocument) return;
          const textSel = window.getSelection()?.toString();
          if (!textSel || textSel.length === 0) {
            e.preventDefault();
            handleCopySelectedLayer();
            return;
          }
        }
        // Paste Layer: Ctrl+V
        if (!e.shiftKey && (code === 'KeyV' || key === 'v')) {
          if (!hasOpenDocument) return;
          e.preventDefault();
          handlePasteSelectedLayer();
          return;
        }
        // Group Layers: Ctrl+G
        if (!e.shiftKey && (code === 'KeyG' || key === 'g')) {
          if (!hasOpenDocument) return;
          e.preventDefault();
          handleGroupSelectedLayers();
          return;
        }
        // Transform: Ctrl+T
        if (!e.shiftKey && (code === 'KeyT' || key === 't')) {
          if (!hasOpenDocument) return;
          e.preventDefault();
          handleStartTransform();
          return;
        }
        // Select All: Ctrl+A
        if (!e.shiftKey && (code === 'KeyA' || key === 'a')) {
          if (!hasOpenDocument) return;
          e.preventDefault();
          handleSelectAll();
          return;
        }
        // Deselect: Ctrl+D
        if (!e.shiftKey && (code === 'KeyD' || key === 'd')) {
          if (!hasOpenDocument) return;
          e.preventDefault();
          handleDeselect();
          return;
        }
        // Invert Selection: Ctrl+Shift+I
        if (e.shiftKey && (code === 'KeyI' || key === 'i')) {
          if (!hasOpenDocument) return;
          e.preventDefault();
          handleInvertSelection();
          return;
        }
        // Reverse Gradient (Invert Colors): Ctrl+I
        if (!e.shiftKey && (code === 'KeyI' || key === 'i')) {
          if (!hasOpenDocument || !activeLayer || activeLayer.locked || activeLayer.type !== 'raster') return;
          e.preventDefault();
          handleApplyReverseGradient();
          return;
        }
        // Hue / Saturation / Luminosity: Ctrl+U
        if (!e.shiftKey && (code === 'KeyU' || key === 'u')) {
          if (!hasOpenDocument || !activeLayer || activeLayer.locked || activeLayer.type !== 'raster') return;
          e.preventDefault();
          handleOpenTonalModal('hue-saturation');
          return;
        }
        // Settings: Ctrl+,
        if (!e.shiftKey && (code === 'Comma' || key === ',' || key === '<')) {
          e.preventDefault();
          setIsSettingsModalOpen(true);
          return;
        }
        // Toggle Perspective Ruler: Ctrl+Shift+R
        if (e.shiftKey && (code === 'KeyR' || key === 'r')) {
          e.preventDefault();
          updatePerspectiveRuler((prev) => {
            if (!prev) {
              const next = createDefaultPerspectiveRuler('2-point', dimensions);
              showToast('2-Point Perspective Ruler added to canvas');
              return next;
            }
            const next = { ...prev, enabled: !prev.enabled };
            showToast(next.enabled ? 'Perspective Ruler: Shown' : 'Perspective Ruler: Hidden');
            return next;
          });
          return;
        }
        // Toggle Perspective Snapping: Ctrl+Shift+P
        if (e.shiftKey && (code === 'KeyP' || key === 'p')) {
          e.preventDefault();
          updatePerspectiveRuler((prev) => {
            if (!prev) return null;
            const next = { ...prev, snapEnabled: !prev.snapEnabled };
            showToast(next.snapEnabled ? 'Perspective Snapping: ON' : 'Perspective Snapping: OFF');
            return next;
          });
          return;
        }
        return;
      }

      // Alt-only shortcuts: Alt+C -> Add Animation Cel
      if (e.altKey && !e.ctrlKey && !e.metaKey) {
        if (!e.shiftKey && (code === 'KeyC' || key === 'c')) {
          if (!hasOpenDocument || !activeAnimationTimeline) return;
          e.preventDefault();
          // Revert temporary Alt pipette if it activated on Alt down
          if (isAltActiveRef.current && previousToolBeforeAltRef.current !== null) {
            setTool(previousToolBeforeAltRef.current);
            previousToolBeforeAltRef.current = null;
            isAltActiveRef.current = false;
          }
          handleAddAnimationCel(activeAnimationTimeline.currentFrame);
        }
        return;
      }

      // Tab / Shift+Tab: Toggle UI Panels (CSP workspace hide)
      if (code === 'Tab' && !textSession) {
        e.preventDefault();
        if (e.shiftKey) {
          setIsLeftPanelHidden((prev) => !prev);
        } else {
          const hideBoth = !(isLeftPanelHidden && isRightSidebarHidden);
          setIsLeftPanelHidden(hideBoth);
          setIsRightSidebarHidden(hideBoth);
        }
        return;
      }

      // Brush Size Stepper: [ and ] (BracketLeft / BracketRight, supports key-repeat)
      if (!e.shiftKey && (code === 'BracketLeft' || code === 'BracketRight')) {
        e.preventDefault();
        const dir: -1 | 1 = code === 'BracketLeft' ? -1 : 1;
        if (toolRef.current === 'liquify') {
          const nextSize = Math.max(4, Math.min(500, Math.round(stepBrushSizePreset(liquifySettings.size, dir))));
          handleUpdateLiquifySettings({ size: nextSize });
        } else {
          const nextSize = stepBrushSizePreset(brushSettings.size, dir);
          updateBrushSettings({ size: nextSize });
        }
        return;
      }

      // Single-key tool & color shortcuts (no modifiers)
      if (!e.shiftKey) {
        const mappedTool = CODE_TO_TOOL[code];
        if (mappedTool) {
          if (e.repeat) return;
          const prev = toolRef.current;
          if (prev !== mappedTool) {
            tempToolHoldRef.current = {
              code,
              prevTool: prev,
              targetTool: mappedTool,
              downAt: performance.now(),
              usedWhileHeld: false,
            };
            handleSelectTool(mappedTool);
          }
          return;
        }

        if (code === 'KeyX' || key === 'x') {
          if (!e.repeat) handleSwapColors();
          return;
        }
        if (code === 'KeyD' || key === 'd') {
          if (!e.repeat) handleResetDefaultColors();
          return;
        }
        if (code === 'KeyC' || key === 'c') {
          if (!e.repeat) toggleTransparentColor();
          return;
        }
      }

      if (key === 'delete' || key === 'backspace') {
        if (!hasOpenDocument) return;
        e.preventDefault();
        if (selection) {
          handleClearSelection();
        } else {
          handleDeleteSelectedLayer();
        }
      } else if (key === 'escape') {
        if (transformSession?.active) {
          e.preventDefault();
          handleCancelTransform();
        } else if (textSession) {
          e.preventDefault();
          handleCancelText();
        } else if (selection) {
          e.preventDefault();
          handleDeselect();
        }
      } else if (key === 'enter') {
        if (transformSession?.active) {
          e.preventDefault();
          handleApplyTransform();
        }
      }
    };

    const handleKeyUp = (e: KeyboardEvent) => {
      const hold = tempToolHoldRef.current;
      if (hold && e.code === hold.code) {
        const heldMs = performance.now() - hold.downAt;
        tempToolHoldRef.current = null;
        if ((heldMs >= 220 || hold.usedWhileHeld) && toolRef.current === hold.targetTool) {
          handleSelectTool(hold.prevTool);
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
  }, [
    activeAnimationTimeline,
    activeLayer,
    activeLayerId,
    brushSettings.size,
    dimensions,
    duplicateLayer,
    handleAddAnimationCel,
    handleAddLayer,
    handleApplyReverseGradient,
    handleApplyTransform,
    handleCancelText,
    handleCancelTransform,
    handleClearSelection,
    handleCopySelectedLayer,
    handleDeleteSelectedLayer,
    handleDeselect,
    handleGroupSelectedLayers,
    handleInvertSelection,
    handleOpenTonalModal,
    handlePasteSelectedLayer,
    handleResetDefaultColors,
    handleSave,
    handleSaveAs,
    handleSelectAll,
    handleSelectTool,
    handleStartTransform,
    handleSwapColors,
    handleTriggerOpenFile,
    handleUndo,
    handleUpdateAnimationTimeline,
    handleUpdateLiquifySettings,
    hasOpenDocument,
    isLeftPanelHidden,
    isRightSidebarHidden,
    layers,
    liquifySettings.size,
    redo,
    selection,
    showToast,
    textSession,
    toggleGamutWarning,
    toggleSoftProof,
    toggleTransparentColor,
    transformSession,
    updateBrushSettings,
    updatePerspectiveRuler,
  ]);

  // Pipette tool: hold Alt to activate, release Alt to switch back to previous tool
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (
        isAnyModalOpenRef.current ||
        (target && (['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName) || target.isContentEditable))
      ) {
        return;
      }

      if (e.key === 'Alt') {
        if (
          !e.ctrlKey &&
          !e.metaKey &&
          !isDrawingRef.current &&
          !selectionPenDrawingRef.current?.isDrawing
        ) {
          e.preventDefault();
          if (!isAltActiveRef.current && !e.repeat) {
            isAltActiveRef.current = true;
            if (toolRef.current !== 'pipette') {
              previousToolBeforeAltRef.current = toolRef.current;
              setTool('pipette');
            }
          }
        }
        return;
      }

      // If user presses Ctrl or Space while Alt is active (Ctrl+Alt resize or Alt+Space play), revert pipette
      if (((e.ctrlKey || e.metaKey) || e.code === 'Space') && isAltActiveRef.current) {
        if (previousToolBeforeAltRef.current !== null) {
          setTool(previousToolBeforeAltRef.current);
          previousToolBeforeAltRef.current = null;
        }
        isAltActiveRef.current = false;
        isPipetteSamplingRef.current = false;
      }
    };

    const handleKeyUp = (e: KeyboardEvent) => {
      if (e.key === 'Alt' || (!e.altKey && isAltActiveRef.current)) {
        if (isAltActiveRef.current) {
          e.preventDefault();
          isAltActiveRef.current = false;
        }
        isPipetteSamplingRef.current = false;
        if (previousToolBeforeAltRef.current !== null) {
          setTool(previousToolBeforeAltRef.current);
          previousToolBeforeAltRef.current = null;
        }
      }
    };

    const handleBlur = () => {
      isAltActiveRef.current = false;
      isPipetteSamplingRef.current = false;
      if (previousToolBeforeAltRef.current !== null) {
        setTool(previousToolBeforeAltRef.current);
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
  }, [isDrawingRef]);

  // Drag and drop onto application window
  useEffect(() => {
    const handleDragOver = (e: DragEvent) => {
      e.preventDefault();
    };

    const handleDrop = async (e: DragEvent) => {
      e.preventDefault();
      if (e.dataTransfer?.files && e.dataTransfer.files.length > 0) {
        const file = e.dataTransfer.files[0];
        if (file.name.toLowerCase().endsWith('.sut')) {
          try {
            setIsLoadingFile(true);
            setLoadingStatus(`Importing CSP Brush: ${file.name}...`);
            const buffer = await file.arrayBuffer();
            const parsedBrush = await parseSutFile(buffer, file.name);
            const existing = (await loadCustomBrushes()).filter(
              (b) => b.name.toLowerCase() === parsedBrush.name.toLowerCase() || b.id === parsedBrush.id
            );
            for (const old of existing) {
              await deleteCustomBrush(old.id).catch(() => {});
            }
            await saveCustomBrush(parsedBrush);
            setTool('brush');
            const fullSettings = await prepareBrushSettingsForCsp(parsedBrush);
            updateBrushSettings(fullSettings);
            showToast(`Imported CSP brush "${parsedBrush.name}" successfully!`);
          } catch (err: any) {
            console.error('Failed to import CSP brush:', err);
            showToast(err.message || 'Failed to import .sut brush.');
          } finally {
            setIsLoadingFile(false);
          }
          return;
        }
        handleProcessFile(file);
      }
    };

    window.addEventListener('dragover', handleDragOver);
    window.addEventListener('drop', handleDrop);
    return () => {
      window.removeEventListener('dragover', handleDragOver);
      window.removeEventListener('drop', handleDrop);
    };
  }, [handleProcessFile, showToast, updateBrushSettings]);

  // Application Menu Bar Sections (Memoized to prevent 240Hz navigation re-allocations)
  const menuSections: MenuSection[] = useMemo(() => [
    {
      id: 'file',
      label: 'File',
      items: [
        // Category 1: Creation & Opening
        {
          id: 'file-new',
          label: 'New...',
          shortcut: 'Ctrl+N',
          icon: <FilePlus className="w-3.5 h-3.5 text-sky-400" />,
          onClick: () => setIsNewCanvasModalOpen(true),
        },
        {
          id: 'file-open',
          label: 'Open...',
          shortcut: 'Ctrl+O',
          icon: <FolderOpen className="w-3.5 h-3.5 text-amber-400" />,
          onClick: handleTriggerOpenFile,
        },
        {
          id: 'file-import-sut',
          label: 'Import CSP Brush (.sut)...',
          icon: <FolderDown className="w-3.5 h-3.5 text-cyan-400" />,
          onClick: () => {
            const input = document.createElement('input');
            input.type = 'file';
            input.accept = '.sut';
            input.onchange = async () => {
              const file = input.files?.[0];
              if (file) {
                try {
                  setIsLoadingFile(true);
                  setLoadingStatus(`Importing CSP Brush: ${file.name}...`);
                  const buffer = await file.arrayBuffer();
                  const parsedBrush = await parseSutFile(buffer, file.name);
                  const existing = (await loadCustomBrushes()).filter(
                    (b) => b.name.toLowerCase() === parsedBrush.name.toLowerCase() || b.id === parsedBrush.id
                  );
                  for (const old of existing) {
                    await deleteCustomBrush(old.id).catch(() => {});
                  }
                  await saveCustomBrush(parsedBrush);
                  setTool('brush');
                  const fullSettings = await prepareBrushSettingsForCsp(parsedBrush);
                  updateBrushSettings(fullSettings);
                  showToast(`Imported CSP brush "${parsedBrush.name}" successfully!`);
                } catch (err: any) {
                  showToast(err.message || 'Failed to import .sut brush.');
                } finally {
                  setIsLoadingFile(false);
                }
              }
            };
            input.click();
          },
        },
        {
          id: 'file-import-3d',
          label: 'Import 3D Model (.glb, .obj)...',
          icon: <Box className="w-3.5 h-3.5 text-purple-400" />,
          disabled: !hasOpenDocument,
          onClick: handleTriggerImport3DFile,
        },
        {
          id: 'file-div-1',
          label: '',
          divider: true,
        },
        // Category 2: Saving & Exporting
        {
          id: 'file-save',
          label: 'Save',
          shortcut: 'Ctrl+S',
          icon: <Save className="w-3.5 h-3.5 text-blue-400" />,
          disabled: !hasOpenDocument,
          onClick: handleSave,
        },
        {
          id: 'file-save-as',
          label: 'Save As...',
          shortcut: 'Ctrl+Shift+S',
          icon: <Save className="w-3.5 h-3.5 text-indigo-400" />,
          disabled: !hasOpenDocument,
          onClick: handleSaveAs,
        },
        {
          id: 'file-export-image',
          label: 'Export Image...',
          icon: <Download className="w-3.5 h-3.5 text-emerald-400" />,
          disabled: !hasOpenDocument,
          onClick: handleExportImage,
        },
        {
          id: 'file-export-webtoon',
          label: 'Export Webtoon Chapter Slices (.zip)...',
          icon: <Archive className="w-3.5 h-3.5 text-cyan-400" />,
          disabled: !hasOpenDocument,
          onClick: () => setIsWebtoonExportModalOpen(true),
        },
        {
          id: 'file-div-2',
          label: '',
          divider: true,
        },
        // Category 3: Canvas Actions
        {
          id: 'file-clear',
          label: 'Clear Canvas',
          icon: <Trash2 className="w-3.5 h-3.5 text-rose-400" />,
          danger: true,
          disabled: !hasOpenDocument,
          onClick: clearCanvas,
        },
      ],
    },
    {
      id: 'edit',
      label: 'Edit',
      items: [
        {
          id: 'edit-undo',
          label: 'Undo',
          shortcut: 'Ctrl+Z',
          icon: <Undo2 className="w-3.5 h-3.5" />,
          disabled: !hasOpenDocument || !canUndo,
          onClick: handleUndo,
        },
        {
          id: 'edit-redo',
          label: 'Redo',
          shortcut: 'Ctrl+Y',
          icon: <Redo2 className="w-3.5 h-3.5" />,
          disabled: !hasOpenDocument || !canRedo,
          onClick: redo,
        },
        {
          id: 'edit-div-1',
          label: '',
          divider: true,
        },
        {
          id: 'edit-copy',
          label: 'Copy',
          shortcut: 'Ctrl+C',
          icon: <Copy className="w-3.5 h-3.5 text-sky-400" />,
          disabled: !hasOpenDocument || !activeLayer,
          onClick: handleCopySelectedLayer,
        },
        {
          id: 'edit-paste',
          label: 'Paste',
          shortcut: 'Ctrl+V',
          icon: <ClipboardPaste className="w-3.5 h-3.5 text-amber-400" />,
          disabled: !hasOpenDocument,
          onClick: handlePasteSelectedLayer,
        },
        {
          id: 'edit-paste-file',
          label: 'Paste from file...',
          icon: <ImagePlus className="w-3.5 h-3.5 text-emerald-400" />,
          disabled: !hasOpenDocument,
          onClick: handleTriggerPasteFromFile,
        },
        {
          id: 'edit-import-3d',
          label: 'Import 3D File (.glb, .obj)...',
          icon: <Box className="w-3.5 h-3.5 text-purple-400" />,
          disabled: !hasOpenDocument,
          onClick: handleTriggerImport3DFile,
        },
        {
          id: 'edit-delete',
          label: 'Delete',
          shortcut: 'Del',
          icon: <Trash2 className="w-3.5 h-3.5 text-rose-400" />,
          danger: true,
          disabled: !hasOpenDocument || layers.filter((l) => l.type === 'raster').length <= 1,
          onClick: handleDeleteSelectedLayer,
        },
        {
          id: 'edit-clear-layer',
          label: 'Clear Active Layer',
          disabled: !hasOpenDocument || !activeLayer,
          onClick: handleClearActiveLayer,
        },
        {
          id: 'edit-transform',
          label: 'Free Transform',
          shortcut: 'Ctrl+T',
          icon: <Scaling className="w-3.5 h-3.5 text-cyan-400" />,
          disabled: !hasOpenDocument,
          onClick: handleStartTransform,
        },
        {
          id: 'edit-deselect',
          label: 'Deselect',
          shortcut: 'Ctrl+D',
          disabled: !hasOpenDocument || !selection,
          onClick: handleDeselect,
        },
        {
          id: 'edit-fill-sel',
          label: 'Fill Selection',
          icon: <PaintBucket className="w-3.5 h-3.5 text-amber-400" />,
          disabled: !hasOpenDocument || !selection,
          onClick: handleFillSelectionColor,
        },
        {
          id: 'edit-tonal-correction',
          label: 'Tonal Correction',
          icon: <SlidersHorizontal className="w-3.5 h-3.5 text-violet-400" />,
          disabled: !hasOpenDocument || !activeLayer || activeLayer.locked || activeLayer.type !== 'raster',
          submenu: [
            {
              id: 'edit-tonal-brightness-contrast',
              label: 'Brightness/Contrast...',
              disabled: !hasOpenDocument || !activeLayer || activeLayer.locked || activeLayer.type !== 'raster',
              onClick: () => handleOpenTonalModal('brightness-contrast'),
            },
            {
              id: 'edit-tonal-hue-saturation',
              label: 'Hue/Saturation/Luminosity...',
              shortcut: 'Ctrl+U',
              disabled: !hasOpenDocument || !activeLayer || activeLayer.locked || activeLayer.type !== 'raster',
              onClick: () => handleOpenTonalModal('hue-saturation'),
            },
            {
              id: 'edit-tonal-posterization',
              label: 'Posterization...',
              disabled: !hasOpenDocument || !activeLayer || activeLayer.locked || activeLayer.type !== 'raster',
              onClick: () => handleOpenTonalModal('posterization'),
            },
            {
              id: 'edit-tonal-reverse-gradient',
              label: 'Reverse Gradient',
              shortcut: 'Ctrl+I',
              disabled: !hasOpenDocument || !activeLayer || activeLayer.locked || activeLayer.type !== 'raster',
              onClick: handleApplyReverseGradient,
            },
            {
              id: 'edit-tonal-level-correction',
              label: 'Level Correction...',
              disabled: !hasOpenDocument || !activeLayer || activeLayer.locked || activeLayer.type !== 'raster',
              onClick: () => handleOpenTonalModal('level-correction'),
            },
            {
              id: 'edit-tonal-binarization',
              label: 'Binarization...',
              disabled: !hasOpenDocument || !activeLayer || activeLayer.locked || activeLayer.type !== 'raster',
              onClick: () => handleOpenTonalModal('binarization'),
            },
          ],
        },
        {
          id: 'edit-div-2',
          label: '',
          divider: true,
        },
        {
          id: 'edit-resize-canvas',
          label: 'Resize Canvas...',
          icon: <Scaling className="w-3.5 h-3.5 text-indigo-400" />,
          disabled: !hasOpenDocument,
          onClick: () => setIsResizeCanvasModalOpen(true),
        },
        {
          id: 'edit-div-3',
          label: '',
          divider: true,
        },
        {
          id: 'edit-settings',
          label: 'Settings...',
          shortcut: 'Ctrl+,',
          icon: <Settings className="w-3.5 h-3.5 text-slate-300" />,
          onClick: () => setIsSettingsModalOpen(true),
        },
      ],
    },
    {
      id: 'select',
      label: 'Select',
      items: [
        {
          id: 'select-all',
          label: 'Select All',
          shortcut: 'Ctrl+A',
          icon: <BoxSelect className="w-3.5 h-3.5 text-sky-400" />,
          disabled: !hasOpenDocument,
          onClick: handleSelectAll,
        },
        {
          id: 'select-deselect',
          label: 'Deselect',
          shortcut: 'Ctrl+D',
          icon: <X className="w-3.5 h-3.5 text-rose-400" />,
          disabled: !hasOpenDocument || !selection,
          onClick: handleDeselect,
        },
        {
          id: 'select-invert',
          label: 'Invert Selection',
          shortcut: 'Ctrl+Shift+I',
          icon: <RotateCcw className="w-3.5 h-3.5 text-amber-400" />,
          disabled: !hasOpenDocument,
          onClick: handleInvertSelection,
        },
        {
          id: 'select-div-1',
          label: '',
          divider: true,
        },
        {
          id: 'select-expand',
          label: 'Expand (+5px)...',
          icon: <Maximize2 className="w-3.5 h-3.5 text-indigo-400" />,
          disabled: !hasOpenDocument || !selection,
          onClick: () => handleExpandSelection(5),
        },
        {
          id: 'select-contract',
          label: 'Contract (-5px)...',
          icon: <Minimize2 className="w-3.5 h-3.5 text-emerald-400" />,
          disabled: !hasOpenDocument || !selection,
          onClick: () => handleContractSelection(5),
        },
        {
          id: 'select-feather',
          label: 'Feather (5px)...',
          icon: <Feather className="w-3.5 h-3.5 text-purple-400" />,
          disabled: !hasOpenDocument || !selection,
          onClick: () => handleFeatherSelection(5),
        },
        {
          id: 'select-div-2',
          label: '',
          divider: true,
        },
        {
          id: 'select-transform',
          label: 'Transform Selection',
          shortcut: 'Ctrl+T',
          icon: <Scaling className="w-3.5 h-3.5 text-cyan-400" />,
          disabled: !hasOpenDocument || !selection,
          onClick: handleStartTransform,
        },
      ],
    },
    {
      id: 'layer',
      label: 'Layer',
      items: [
        {
          id: 'layer-new-raster',
          label: 'New Raster Layer',
          shortcut: 'Ctrl+Shift+N',
          icon: <Plus className="w-3.5 h-3.5" />,
          disabled: !hasOpenDocument,
          onClick: () => handleAddLayer('raster'),
        },
        {
          id: 'layer-new-folder',
          label: 'New Folder',
          disabled: !hasOpenDocument,
          onClick: () => handleAddLayer('folder'),
        },
        {
          id: 'layer-new-3d',
          label: 'New 3D Reference Layer...',
          icon: <Box className="w-3.5 h-3.5 text-purple-400" />,
          disabled: !hasOpenDocument,
          onClick: () => setIs3DLayerOpen(true),
        },
        {
          id: 'layer-new-adjustment',
          label: 'New Adjustment Layer',
          disabled: !hasOpenDocument,
          submenu: [
            {
              id: 'layer-adj-curves',
              label: 'Tone Curves...',
              onClick: () => handleOpenAdjustmentModal(undefined, 'curves'),
            },
            {
              id: 'layer-adj-gradient-map',
              label: 'Gradient Map...',
              onClick: () => handleOpenAdjustmentModal(undefined, 'gradient-map'),
            },
            {
              id: 'layer-adj-levels',
              label: 'Levels...',
              onClick: () => handleOpenAdjustmentModal(undefined, 'levels'),
            },
            {
              id: 'layer-adj-color-balance',
              label: 'Color Balance...',
              onClick: () => handleOpenAdjustmentModal(undefined, 'color-balance'),
            },
          ],
        },
        {
          id: 'layer-mask-submenu',
          label: 'Layer Mask',
          disabled: !hasOpenDocument || !activeLayer || activeLayer.type === 'folder',
          submenu: [
            {
              id: 'layer-mask-add',
              label: activeLayer?.maskCanvas ? 'Mask Already Present' : 'Add Layer Mask (Reveal All)',
              disabled: Boolean(activeLayer?.maskCanvas),
              onClick: () => addLayerMask(activeLayerId),
            },
            {
              id: 'layer-mask-delete',
              label: 'Delete Layer Mask',
              danger: true,
              disabled: !activeLayer?.maskCanvas,
              onClick: () => removeLayerMask(activeLayerId),
            },
            {
              id: 'layer-mask-toggle',
              label: activeLayer?.maskEnabled === false ? 'Enable Layer Mask' : 'Disable Layer Mask',
              disabled: !activeLayer?.maskCanvas,
              onClick: () => toggleLayerMask(activeLayerId),
            },
            {
              id: 'layer-mask-link',
              label: activeLayer?.maskLinked === false ? 'Link Mask to Layer' : 'Unlink Mask from Layer',
              disabled: !activeLayer?.maskCanvas,
              onClick: () => toggleMaskLinked(activeLayerId),
            },
          ],
        },
        {
          id: 'layer-duplicate',
          label: 'Duplicate Layer',
          shortcut: 'Ctrl+J',
          disabled: !hasOpenDocument || !activeLayer,
          onClick: () => duplicateLayer(activeLayerId),
        },
        {
          id: 'layer-div-effects',
          label: '',
          divider: true,
        },
        {
          id: 'layer-styles',
          label: 'Layer Style (Stroke, Shadow, Glow)...',
          disabled: !hasOpenDocument || !activeLayer || activeLayer.type === 'folder' || activeLayer.type === 'adjustment',
          onClick: () => handleOpenLayerStylesModal(activeLayerId),
        },
        {
          id: 'layer-toggle-tint',
          label: activeLayer?.layerColorEnabled ? 'Disable Layer Color (Tint)' : 'Enable Layer Color (Tint)',
          disabled: !hasOpenDocument || !activeLayer || activeLayer.type === 'folder',
          onClick: () => toggleLayerColor(activeLayerId),
        },
        {
          id: 'layer-convert-submenu',
          label: 'Convert Expression Color',
          disabled: !hasOpenDocument || !activeLayer || activeLayer.type === 'folder',
          submenu: [
            {
              id: 'layer-convert-color',
              label: 'Color (RGB)',
              onClick: () => handleConvertLayer(activeLayerId, 'color'),
            },
            {
              id: 'layer-convert-gray',
              label: 'Gray (Grayscale)',
              onClick: () => handleConvertLayer(activeLayerId, 'gray'),
            },
            {
              id: 'layer-convert-monochrome',
              label: 'Monochrome (1-bit B&W)',
              onClick: () => handleConvertLayer(activeLayerId, 'monochrome'),
            },
          ],
        },
        {
          id: 'layer-div-ruler',
          label: '',
          divider: true,
        },
        {
          id: 'layer-perspective-ruler',
          label: 'Perspective Ruler',
          disabled: !hasOpenDocument,
          submenu: !perspectiveRuler
            ? [
                {
                  id: 'layer-add-ruler-1p',
                  label: 'Add 1-Point Perspective Ruler',
                  onClick: () => {
                    const next = createDefaultPerspectiveRuler('1-point', dimensions);
                    updatePerspectiveRuler(next);
                    showToast('1-Point Perspective Ruler added to canvas');
                  },
                },
                {
                  id: 'layer-add-ruler-2p',
                  label: 'Add 2-Point Perspective Ruler',
                  onClick: () => {
                    const next = createDefaultPerspectiveRuler('2-point', dimensions);
                    updatePerspectiveRuler(next);
                    showToast('2-Point Perspective Ruler added to canvas');
                  },
                },
                {
                  id: 'layer-add-ruler-3p-birds',
                  label: "Add 3-Point Perspective Ruler (Bird's-Eye)",
                  onClick: () => {
                    const next = createDefaultPerspectiveRuler('3-point', dimensions);
                    updatePerspectiveRuler(next);
                    showToast("3-Point Perspective Ruler (Bird's-Eye) added to canvas");
                  },
                },
                {
                  id: 'layer-add-ruler-3p-worms',
                  label: "Add 3-Point Perspective Ruler (Worm's-Eye)",
                  onClick: () => {
                    const base = createDefaultPerspectiveRuler('3-point', dimensions);
                    const next = applyWormsEyePreset(base, dimensions);
                    updatePerspectiveRuler(next);
                    showToast("3-Point Perspective Ruler (Worm's-Eye) added to canvas");
                  },
                },
              ]
            : [
                {
                  id: 'layer-remove-ruler',
                  label: 'Remove Perspective Ruler from Canvas',
                  danger: true,
                  onClick: () => {
                    updatePerspectiveRuler(null);
                    showToast('Removed perspective ruler from canvas');
                  },
                },
              ],
        },
        {
          id: 'layer-div-delete',
          label: '',
          divider: true,
        },
        {
          id: 'layer-delete',
          label: 'Delete Layer',
          danger: true,
          disabled: !hasOpenDocument || layers.length <= 1,
          onClick: () => deleteLayer(activeLayerId),
        },
      ],
    },
    {
      id: 'filter',
      label: 'Filter',
      items: [
        {
          id: 'filter-gaussian-blur',
          label: 'Gaussian Blur...',
          disabled: !hasOpenDocument || !activeLayer || activeLayer.type !== 'raster' || activeLayer.locked,
          onClick: () => {
            const r = window.prompt('Gaussian Blur Radius (px, 1-100):', '5');
            if (r !== null) {
              const radius = Math.max(1, Math.min(100, parseFloat(r) || 5));
              handleApplyFilter('gaussian-blur', { radius });
            }
          },
        },
        {
          id: 'filter-motion-blur',
          label: 'Motion Blur...',
          disabled: !hasOpenDocument || !activeLayer || activeLayer.type !== 'raster' || activeLayer.locked,
          onClick: () => {
            const d = window.prompt('Motion Blur Distance (px, 1-100):', '15');
            const a = d !== null ? window.prompt('Motion Blur Angle (degrees, 0-360):', '0') : null;
            if (d !== null && a !== null) {
              const distance = Math.max(1, Math.min(100, parseFloat(d) || 15));
              const angle = Math.max(0, Math.min(360, parseFloat(a) || 0));
              handleApplyFilter('motion-blur', { distance, angle });
            }
          },
        },
        {
          id: 'filter-unsharp-mask',
          label: 'Unsharp Mask...',
          disabled: !hasOpenDocument || !activeLayer || activeLayer.type !== 'raster' || activeLayer.locked,
          onClick: () => {
            const r = window.prompt('Unsharp Mask Radius (px, 0.5-20):', '2');
            const a = r !== null ? window.prompt('Amount factor (0.1-5.0):', '1.5') : null;
            if (r !== null && a !== null) {
              const radius = Math.max(0.5, Math.min(20, parseFloat(r) || 2));
              const amount = Math.max(0.1, Math.min(5, parseFloat(a) || 1.5));
              handleApplyFilter('unsharp-mask', { radius, amount, threshold: 0 });
            }
          },
        },
        {
          id: 'filter-film-grain',
          label: 'Film Grain...',
          disabled: !hasOpenDocument || !activeLayer || activeLayer.type !== 'raster' || activeLayer.locked,
          onClick: () => {
            const i = window.prompt('Film Grain Intensity (% 1-100):', '25');
            if (i !== null) {
              const intensity = Math.max(1, Math.min(100, parseFloat(i) || 25));
              handleApplyFilter('film-grain', { intensity, size: 1, monochromatic: true });
            }
          },
        },
      ],
    },
    {
      id: 'ruler',
      label: 'Ruler',
      items: [
        ...(!perspectiveRuler
          ? [
              {
                id: 'ruler-add-1p',
                label: 'Add 1-Point Perspective Ruler',
                icon: <Compass className="w-3.5 h-3.5 text-cyan-400" />,
                disabled: !hasOpenDocument,
                onClick: () => {
                  const next = createDefaultPerspectiveRuler('1-point', dimensions);
                  updatePerspectiveRuler(next);
                  showToast('1-Point Perspective Ruler added to canvas');
                },
              },
              {
                id: 'ruler-add-2p',
                label: 'Add 2-Point Perspective Ruler',
                icon: <Compass className="w-3.5 h-3.5 text-purple-400" />,
                disabled: !hasOpenDocument,
                onClick: () => {
                  const next = createDefaultPerspectiveRuler('2-point', dimensions);
                  updatePerspectiveRuler(next);
                  showToast('2-Point Perspective Ruler added to canvas');
                },
              },
              {
                id: 'ruler-add-3p-birds',
                label: "Add 3-Point Perspective Ruler (Bird's-Eye)",
                icon: <Compass className="w-3.5 h-3.5 text-emerald-400" />,
                disabled: !hasOpenDocument,
                onClick: () => {
                  const next = createDefaultPerspectiveRuler('3-point', dimensions);
                  updatePerspectiveRuler(next);
                  showToast("3-Point Perspective Ruler (Bird's-Eye) added to canvas");
                },
              },
              {
                id: 'ruler-add-3p-worms',
                label: "Add 3-Point Perspective Ruler (Worm's-Eye)",
                icon: <Compass className="w-3.5 h-3.5 text-amber-400" />,
                disabled: !hasOpenDocument,
                onClick: () => {
                  const base = createDefaultPerspectiveRuler('3-point', dimensions);
                  const next = applyWormsEyePreset(base, dimensions);
                  updatePerspectiveRuler(next);
                  showToast("3-Point Perspective Ruler (Worm's-Eye) added to canvas");
                },
              },
            ]
          : [
              {
                id: 'ruler-toggle-visibility',
                label: perspectiveRuler.enabled
                  ? 'Hide Perspective Ruler'
                  : 'Show Perspective Ruler',
                shortcut: 'Ctrl+Shift+R',
                icon: perspectiveRuler.enabled ? (
                  <EyeOff className="w-3.5 h-3.5 text-sky-400" />
                ) : (
                  <Eye className="w-3.5 h-3.5 text-sky-400" />
                ),
                disabled: !hasOpenDocument,
                onClick: () =>
                  updatePerspectiveRuler((prev) =>
                    prev ? { ...prev, enabled: !prev.enabled } : null
                  ),
              },
              {
                id: 'ruler-toggle-snap',
                label: perspectiveRuler.snapEnabled
                  ? 'Disable Snapping'
                  : 'Enable Snapping',
                shortcut: 'Ctrl+Shift+P',
                icon: <Magnet className="w-3.5 h-3.5 text-emerald-400" />,
                disabled: !hasOpenDocument,
                onClick: () =>
                  updatePerspectiveRuler((prev) =>
                    prev ? { ...prev, snapEnabled: !prev.snapEnabled } : null
                  ),
              },
              {
                id: 'ruler-toggle-lock',
                label: perspectiveRuler.locked
                  ? 'Unlock Handles (Edit Mode)'
                  : 'Lock Handles (Freeze for Inking)',
                icon: perspectiveRuler.locked ? (
                  <Unlock className="w-3.5 h-3.5 text-amber-400" />
                ) : (
                  <Lock className="w-3.5 h-3.5 text-amber-400" />
                ),
                disabled: !hasOpenDocument,
                onClick: () =>
                  updatePerspectiveRuler((prev) =>
                    prev ? { ...prev, locked: !prev.locked } : null
                  ),
              },
              {
                id: 'ruler-line-count',
                label: `Guide Rays (${perspectiveRuler.guideRayCount || 6} lines)`,
                disabled: !hasOpenDocument,
                submenu: [2, 4, 6, 8, 12, 16].map((count) => ({
                  id: `ruler-rays-${count}`,
                  label: `${count} Rays per VP`,
                  checked: (perspectiveRuler.guideRayCount || 6) === count,
                  onClick: () =>
                    updatePerspectiveRuler((prev) =>
                      prev ? { ...prev, guideRayCount: count } : null
                    ),
                })),
              },
              {
                id: 'ruler-presets',
                label: 'Change Perspective Preset',
                disabled: !hasOpenDocument,
                submenu: [
                  {
                    id: 'ruler-preset-1p',
                    label: '1-Point Perspective (Center)',
                    onClick: () => {
                      const next = createDefaultPerspectiveRuler('1-point', dimensions);
                      next.snapEnabled = perspectiveRuler.snapEnabled;
                      next.locked = perspectiveRuler.locked;
                      next.guideRayCount = perspectiveRuler.guideRayCount;
                      updatePerspectiveRuler(next);
                    },
                  },
                  {
                    id: 'ruler-preset-2p',
                    label: '2-Point Perspective (Wide Street)',
                    onClick: () => {
                      const next = createDefaultPerspectiveRuler('2-point', dimensions);
                      next.snapEnabled = perspectiveRuler.snapEnabled;
                      next.locked = perspectiveRuler.locked;
                      next.guideRayCount = perspectiveRuler.guideRayCount;
                      updatePerspectiveRuler(next);
                    },
                  },
                  {
                    id: 'ruler-preset-3p-birds',
                    label: "3-Point Perspective (Bird's-Eye)",
                    onClick: () => {
                      const next = createDefaultPerspectiveRuler('3-point', dimensions);
                      next.snapEnabled = perspectiveRuler.snapEnabled;
                      next.locked = perspectiveRuler.locked;
                      next.guideRayCount = perspectiveRuler.guideRayCount;
                      updatePerspectiveRuler(next);
                    },
                  },
                  {
                    id: 'ruler-preset-3p-worms',
                    label: "3-Point Perspective (Worm's-Eye)",
                    onClick: () => {
                      const base = createDefaultPerspectiveRuler('3-point', dimensions);
                      base.guideRayCount = perspectiveRuler.guideRayCount;
                      const next = applyWormsEyePreset(base, dimensions);
                      updatePerspectiveRuler(next);
                    },
                  },
                ],
              },
              {
                id: 'ruler-div-remove',
                label: '',
                divider: true,
              },
              {
                id: 'ruler-remove',
                label: 'Remove Perspective Ruler from Canvas',
                danger: true,
                icon: <Trash2 className="w-3.5 h-3.5 text-red-400" />,
                disabled: !hasOpenDocument,
                onClick: () => {
                  updatePerspectiveRuler(null);
                  showToast('Removed perspective ruler from canvas');
                },
              },
            ]),
      ],
    },
    {
      id: 'view',
      label: 'View',
      items: [
        {
          id: 'view-zoom-in',
          label: 'Zoom In',
          shortcut: 'Ctrl++',
          icon: <ZoomIn className="w-3.5 h-3.5" />,
          disabled: !hasOpenDocument,
          onClick: zoomIn,
        },
        {
          id: 'view-zoom-out',
          label: 'Zoom Out',
          shortcut: 'Ctrl+-',
          icon: <ZoomOut className="w-3.5 h-3.5" />,
          disabled: !hasOpenDocument,
          onClick: zoomOut,
        },
        {
          id: 'view-reset-zoom',
          label: 'Reset Zoom & Center',
          shortcut: 'Ctrl+0',
          disabled: !hasOpenDocument,
          onClick: resetZoomAndCenter,
        },
        {
          id: 'view-reset-rotation',
          label: 'Reset Rotation',
          shortcut: 'Ctrl+Alt+0',
          icon: <RotateCcw className="w-3.5 h-3.5" />,
          disabled: !hasOpenDocument,
          onClick: resetRotation,
        },
        {
          id: 'view-div-ruler',
          label: '',
          divider: true,
        },
        {
          id: 'view-toggle-ruler',
          label: perspectiveRuler?.enabled ? 'Hide Perspective Ruler' : 'Show Perspective Ruler',
          shortcut: 'Ctrl+Shift+R',
          disabled: !hasOpenDocument || !perspectiveRuler,
          onClick: () =>
            updatePerspectiveRuler((prev) =>
              prev ? { ...prev, enabled: !prev.enabled } : null
            ),
        },
        {
          id: 'view-toggle-snap',
          label: perspectiveRuler?.snapEnabled
            ? 'Disable Perspective Snapping'
            : 'Enable Perspective Snapping',
          shortcut: 'Ctrl+Shift+P',
          disabled: !hasOpenDocument || !perspectiveRuler,
          onClick: () =>
            updatePerspectiveRuler((prev) =>
              prev ? { ...prev, snapEnabled: !prev.snapEnabled } : null
            ),
        },
        {
          id: 'view-div-webtoon',
          label: '',
          divider: true,
        },
        {
          id: 'view-webtoon-mode',
          label: isWebtoonMode ? 'Exit Webtoon Studio Mode' : 'Webtoon Studio Mode (9:16 Mockup)',
          icon: <Smartphone className="w-3.5 h-3.5 text-emerald-400" />,
          disabled: !hasOpenDocument,
          onClick: () => setIsWebtoonMode((prev) => !prev),
        },
        {
          id: 'view-div-soft-proof',
          label: '',
          divider: true,
        },
        {
          id: 'view-proof-setup',
          label: 'Proof Setup',
          disabled: !hasOpenDocument,
          submenu: [
            {
              id: 'proof-setup-us-web',
              label: 'Working CMYK - U.S. Web Coated (SWOP) v2',
              checked: softProofSettings.standard === 'us-web-coated-swop',
              onClick: () => setProofStandard('us-web-coated-swop'),
            },
            {
              id: 'proof-setup-japan',
              label: 'Japan Color 2001 Coated',
              checked: softProofSettings.standard === 'japan-color-2001',
              onClick: () => setProofStandard('japan-color-2001'),
            },
            {
              id: 'proof-setup-iso',
              label: 'ISO Coated v2 (ECI)',
              checked: softProofSettings.standard === 'iso-coated-v2',
              onClick: () => setProofStandard('iso-coated-v2'),
            },
          ],
        },
        {
          id: 'view-proof-colors',
          label: 'Proof Colors',
          shortcut: 'Ctrl+Alt+Y',
          checked: softProofSettings.enabled,
          disabled: !hasOpenDocument,
          onClick: toggleSoftProof,
        },
        {
          id: 'view-gamut-warning',
          label: 'Gamut Warning',
          shortcut: 'Ctrl+Shift+Y',
          checked: softProofSettings.gamutWarning,
          disabled: !hasOpenDocument,
          onClick: toggleGamutWarning,
        },
      ],
    },
    {
      id: 'manga',
      label: 'Manga',
      items: [
        {
          id: 'manga-effects-generator',
          label: 'Manga Effect Lines Generator...',
          icon: <Sparkles className="w-3.5 h-3.5 text-amber-400" />,
          disabled: !hasOpenDocument,
          onClick: () => setIsMangaEffectsModalOpen(true),
        },
        {
          id: 'manga-balloon-tool',
          label: 'Parametric Speech Balloon Tool',
          icon: <MessageSquare className="w-3.5 h-3.5 text-cyan-400" />,
          disabled: !hasOpenDocument,
          onClick: () => handleSelectTool('balloon'),
        },
        {
          id: 'manga-correct-line',
          label: 'Correct Line (Vector Pinch/Width/Simplify)',
          icon: <Spline className="w-3.5 h-3.5 text-indigo-400" />,
          disabled: !hasOpenDocument,
          onClick: () => handleSelectTool('vector-edit'),
        },
        {
          id: 'manga-div-webtoon',
          label: '',
          divider: true,
        },
        {
          id: 'manga-webtoon-toggle',
          label: isWebtoonMode ? 'Exit Webtoon Studio Mode' : 'Webtoon Studio Mode (9:16 Simulator)',
          icon: <Smartphone className="w-3.5 h-3.5 text-emerald-400" />,
          disabled: !hasOpenDocument,
          onClick: () => setIsWebtoonMode((prev) => !prev),
        },
        {
          id: 'manga-webtoon-export',
          label: 'Export Webtoon Chapter Slices (.zip)...',
          icon: <Archive className="w-3.5 h-3.5 text-sky-400" />,
          disabled: !hasOpenDocument,
          onClick: () => setIsWebtoonExportModalOpen(true),
        },
      ],
    },
    {
      id: 'animation',
      label: 'Animation',
      items: [
        {
          id: 'anim-toggle-timeline',
          label: activeAnimationTimeline ? 'Hide Animation Timeline' : 'Show Animation Timeline',
          shortcut: 'Ctrl+Alt+A',
          icon: <Film className="w-3.5 h-3.5 text-emerald-400" />,
          disabled: !hasOpenDocument,
          onClick: () => {
            if (activeAnimationTimeline) {
              handleUpdateAnimationTimeline(null);
            } else {
              const tl = createDefaultAnimationTimeline(layers);
              handleUpdateAnimationTimeline(tl);
            }
          },
        },
        {
          id: 'anim-new-cel',
          label: 'Add Cel to Current Frame',
          shortcut: 'Alt+C',
          icon: <Plus className="w-3.5 h-3.5" />,
          disabled: !hasOpenDocument || !activeAnimationTimeline,
          onClick: () => {
            if (activeAnimationTimeline) {
              handleAddAnimationCel(activeAnimationTimeline.currentFrame);
            }
          },
        },
        {
          id: 'anim-toggle-onion',
          label: activeAnimationTimeline?.onionSkin.enabled
            ? 'Disable Onion Skinning'
            : 'Enable Onion Skinning',
          icon: <Layers className="w-3.5 h-3.5 text-purple-400" />,
          disabled: !hasOpenDocument || !activeAnimationTimeline,
          onClick: () => {
            if (activeAnimationTimeline) {
              handleUpdateAnimationTimeline({
                ...activeAnimationTimeline,
                onionSkin: {
                  ...activeAnimationTimeline.onionSkin,
                  enabled: !activeAnimationTimeline.onionSkin.enabled,
                },
              });
            }
          },
        },
      ],
    },
    {
      id: 'help',
      label: 'Help',
      items: [
        {
          id: 'help-about',
          label: 'About Ink Studio',
          icon: <InfoIcon className="w-3.5 h-3.5 text-[#93c5fd]" />,
          onClick: () => {
            alert(
              'Ink Studio - Professional Digital Painting & Manga Studio\n\n' +
                '- Full Layer Management with 17 Blend Modes\n' +
                '- Supports Opening PSD (Photoshop) & CSP (Clip Studio Paint) with layers\n' +
                '- Supports Common Images: PNG, JPG, WEBP, GIF, BMP, SVG\n' +
                '- Save & Save As: PSD (layered), Ink Studio Project (.sora / .ink), PNG, JPG, WebP\n' +
                '- Export Image: High-resolution PNG\n' +
                '- Color Modes: Full Color (RGB), Grayscale, and 1-bit Manga Monochrome\n' +
                '- CSP Sub-Tool Engine, Tablet Pressure, Tilt & Inking Stabilization'
            );
          },
        },
      ],
    },
  ], [
    activeAnimationTimeline,
    activeLayer,
    activeLayerId,
    addLayerMask,
    canRedo,
    canUndo,
    clearCanvas,
    deleteLayer,
    dimensions,
    duplicateLayer,
    handleAddAnimationCel,
    handleAddLayer,
    handleApplyFilter,
    handleApplyReverseGradient,
    handleClearActiveLayer,
    handleContractSelection,
    handleConvertLayer,
    handleCopySelectedLayer,
    handleDeleteSelectedLayer,
    handleDeselect,
    handleExpandSelection,
    handleExportImage,
    handleFeatherSelection,
    handleFillSelectionColor,
    handleInvertSelection,
    handleOpenAdjustmentModal,
    handleOpenLayerStylesModal,
    handleOpenTonalModal,
    handlePasteSelectedLayer,
    handleSave,
    handleSaveAs,
    handleSelectAll,
    handleSelectTool,
    handleStartTransform,
    handleTriggerImport3DFile,
    handleTriggerOpenFile,
    handleTriggerPasteFromFile,
    handleUndo,
    handleUpdateAnimationTimeline,
    hasOpenDocument,
    isWebtoonMode,
    layers,
    perspectiveRuler,
    redo,
    removeLayerMask,
    resetRotation,
    resetZoomAndCenter,
    selection,
    setProofStandard,
    showToast,
    softProofSettings.enabled,
    softProofSettings.gamutWarning,
    softProofSettings.standard,
    toggleGamutWarning,
    toggleLayerColor,
    toggleLayerMask,
    toggleMaskLinked,
    toggleSoftProof,
    updateBrushSettings,
    updatePerspectiveRuler,
    zoomIn,
    zoomOut,
  ]);

  const handleSelectWelcomeDocument = useCallback(
    async (doc: RecentDocument) => {
      // 1. If running in Tauri, attempt to read directly from PC disk
      if (typeof window !== 'undefined' && (window as any).__TAURI_INTERNALS__) {
        try {
          const { invoke } = await import('@tauri-apps/api/core');
          const bytes = await invoke<number[]>('read_file_from_disk', { path: doc.path });
          if (bytes && bytes.length > 0) {
            const uint8 = new Uint8Array(bytes);
            const file = new File([uint8], doc.title, { type: 'application/octet-stream' });
            await handleProcessFile(file);
            setAppView('workspace');
            return;
          }
        } catch (err) {
          console.warn('Direct disk read via Tauri failed, fallback:', err);
        }
      }

      // 2. Fallback: Initialize new canvas with the document title and standard dimensions
      handleCreateNewCanvas({
        width: 1920,
        height: 1080,
        dpi: 300,
        colorMode: 'color',
        name: doc.title,
        backgroundColor: '#ffffff',
        aspectRatioPreset: '16:9',
        aspectRatioX: 16,
        aspectRatioY: 9,
        lockAspectRatio: true,
      });
      showToast(`Loaded workspace for "${doc.title}"`);
    },
    [handleCreateNewCanvas, handleProcessFile, showToast]
  );

  const modernAccent = appSettings.modernAccent || 'neutral';
  const modernAccentHex = resolveModernAccentColor(modernAccent, appSettings.modernCustomColor);
  const modernAccentRgb = hexToRgb(modernAccentHex) || { r: 229, g: 229, b: 229 };
  const modernAccentContrast = getAccentContrastColor(modernAccentHex);

  const modernStyleVars = useMemo(
    () =>
      ({
        '--accent': modernAccentHex,
        '--accent-rgb': `${modernAccentRgb.r}, ${modernAccentRgb.g}, ${modernAccentRgb.b}`,
        '--accent-contrast': modernAccentContrast,
        '--accent-subtle': `rgba(${modernAccentRgb.r}, ${modernAccentRgb.g}, ${modernAccentRgb.b}, 0.14)`,
        '--accent-border': `rgba(${modernAccentRgb.r}, ${modernAccentRgb.g}, ${modernAccentRgb.b}, 0.32)`,
        '--modern-accent': modernAccentHex,
        '--modern-accent-rgb': `${modernAccentRgb.r}, ${modernAccentRgb.g}, ${modernAccentRgb.b}`,
        '--modern-accent-subtle': `rgba(${modernAccentRgb.r}, ${modernAccentRgb.g}, ${modernAccentRgb.b}, 0.14)`,
        '--modern-accent-border': `rgba(${modernAccentRgb.r}, ${modernAccentRgb.g}, ${modernAccentRgb.b}, 0.32)`,
        '--modern-accent-hover': `rgba(${modernAccentRgb.r}, ${modernAccentRgb.g}, ${modernAccentRgb.b}, 0.2)`,
      }) as React.CSSProperties,
    [modernAccentHex, modernAccentRgb.r, modernAccentRgb.g, modernAccentRgb.b, modernAccentContrast]
  );

  return (
    <div
      className="flex flex-col w-screen h-screen overflow-hidden bg-[#161616] text-[#e5e5e5] font-sans gap-px app-root-container"
      data-theme="modern"
      data-accent={modernAccent}
      style={modernStyleVars}
    >
      {/* Hidden File Input for Native File Picker */}
      <input
        ref={fileInputRef}
        type="file"
        accept=".png,.jpg,.jpeg,.webp,.bmp,.gif,.svg,.psd,.psb,.clip,.csp,.sora,.ink,.sut"
        onChange={handleFileInputChange}
        className="hidden"
      />

      {/* Hidden File Input for Paste Photo From File */}
      <input
        ref={pasteFileInputRef}
        type="file"
        accept=".png,.jpg,.jpeg,.webp,.bmp,.gif,.svg,.ico,image/*"
        onChange={handlePasteFileInputChange}
        className="hidden"
      />

      {/* Hidden File Input for 3D Model Import */}
      <input
        ref={import3DFileInputRef}
        type="file"
        accept=".glb,.gltf,.obj"
        onChange={handleImport3DFileInputChange}
        className="hidden"
      />

      {/* Consolidated Single Slim 36px Header Bar */}
      <Header
        canUndo={hasOpenDocument && canUndo}
        canRedo={hasOpenDocument && canRedo}
        onUndo={handleUndo}
        onRedo={redo}
        zoom={zoom}
        onZoomIn={zoomIn}
        onZoomOut={zoomOut}
        onResetZoom={resetZoomAndCenter}
        rotation={rotation}
        onResetRotation={resetRotation}
        dimensions={dimensions}
        colorMode={colorMode}
        menuSections={menuSections}
        hasOpenDocument={hasOpenDocument}
        documents={documents}
        activeDocumentId={activeDocumentId}
        onSelectDocument={handleSelectDocument}
        onCloseDocument={handleCloseDocument}
        onNewDocument={() => setIsNewCanvasModalOpen(true)}
        onRenameDocument={handleRenameDocument}
        isCollabConnected={isCollabConnected}
        collabPeerCount={collabPeers.length + 1}
        onOpenCollabModal={() => setIsHostModalOpen(true)}
        onOpenSettings={() => setIsSettingsModalOpen(true)}
        themePreset={appSettings.themePreset}
        softProofSettings={softProofSettings}
        appView={appView}
        onSelectAppView={(view) => {
          if (view === 'workspace' && !hasOpenDocument) {
            setIsNewCanvasModalOpen(true);
          } else {
            setAppView(view);
          }
        }}
      />

      {/* Main Workspace */}
      <div className="flex flex-1 overflow-hidden relative gap-px bg-[#161616]">
        {!hasOpenDocument || appView === 'home' ? (
          <WelcomeScreen
            userName={appSettings.userName}
            onNewDocument={() => setIsNewCanvasModalOpen(true)}
            onOpenFile={handleTriggerOpenFile}
            onSelectRecentDocument={handleSelectWelcomeDocument}
            showToast={showToast}
            themePreset={appSettings.themePreset}
          />
        ) : (
          <>
            <LeftPanel
              currentTool={tool}
              onSelectTool={handleSelectTool}
              brushSettings={brushSettings}
              onUpdateBrushSettings={updateBrushSettings}
              primaryColor={primaryColor}
              secondaryColor={secondaryColor}
              isTransparentColor={isTransparentColor}
              onToggleTransparentColor={toggleTransparentColor}
              onPrimaryColorChange={handlePrimaryColorChange}
              onSecondaryColorChange={handleSecondaryColorChange}
              onSwapColors={handleSwapColors}
              recentColors={recentColors}
              width={leftPanelWidth}
              onWidthChange={handleLeftPanelWidthChange}
              isHidden={isLeftPanelHidden}
              onToggleHidden={() => setIsLeftPanelHidden((prev) => !prev)}
              fillSettings={fillSettings}
              onUpdateFillSettings={(newSettings) => setFillSettings((prev) => ({ ...prev, ...newSettings }))}
              textSettings={textSettings}
              onUpdateTextSettings={(newSettings) => setTextSettings((prev) => ({ ...prev, ...newSettings }))}
              frameSettings={frameSettings}
              onUpdateFrameSettings={(newSettings) => setFrameSettings((prev) => ({ ...prev, ...newSettings }))}
              hasSelection={Boolean(selection)}
              onDeselect={handleDeselect}
              onTransformSelection={handleStartTransform}
              onFillScreentone={handleFillScreentone}
              liquifySettings={liquifySettings}
              onUpdateLiquifySettings={handleUpdateLiquifySettings}
              balloonSettings={balloonSettings}
              onUpdateBalloonSettings={(newSettings) => setBalloonSettings((prev) => ({ ...prev, ...newSettings }))}
              vectorEditSettings={vectorEditSettings}
              onUpdateVectorEditSettings={(newSettings) => setVectorEditSettings((prev) => ({ ...prev, ...newSettings }))}
              onOpenMangaEffects={() => setIsMangaEffectsModalOpen(true)}
              wandSettings={wandSettings}
              onUpdateWandSettings={(newSettings) => setWandSettings((prev) => ({ ...prev, ...newSettings }))}
              onExpandSelection={handleExpandSelection}
              onContractSelection={handleContractSelection}
              onFeatherSelection={handleFeatherSelection}
              onInvertSelection={handleInvertSelection}
            />

            {/* Center Workspace: >80% Viewport Dedicated to Drawing Canvas */}
            <div className="flex flex-col flex-1 min-w-0 overflow-hidden relative">
              <CanvasArea
                viewportRef={viewportRef}
                onViewportReady={handleViewportReady}
                dimensions={dimensions}
                brushSettings={brushSettings}
                onUpdateBrushSettings={updateBrushSettings}
                zoom={zoom}
                pan={pan}
                rotation={rotation}
                isSpaceDown={isSpaceDown}
                isShiftDown={isShiftDown}
                isRotateModifier={isRotateModifier}
                isPanning={isPanning}
                isRotating={isRotating}
                onStartPan={startPan}
                onStartRotate={startRotate}
                isHovering={isHovering}
                cursorPos={cursorPos}
                onPointerDown={handlePointerDown}
                onPointerMove={handlePointerMove}
                onPointerUp={handlePointerUp}
                onPointerEnter={handlePointerEnter}
                onPointerLeave={handlePointerLeave}
                layers={layers}
                activeLayerId={activeLayerId}
                colorMode={colorMode}
                layerCanvasesRef={layerCanvasesRef}
                registerLayerCanvas={registerLayerCanvas}
                getEffectiveOpacity={getEffectiveOpacity}
                isLayerEffectivelyVisible={isLayerEffectivelyVisible}
                interactionRef={interactionRef}
                showCheckerboard={appSettings.showCheckerboard}
                showCursorCoordinates={appSettings.showCursorCoordinates}
                showPressureInStatusBar={appSettings.showPressureInStatusBar}
                hasOpenDocument={hasOpenDocument}
                draftCanvasRef={draftCanvasRef}
                strokeCanvasRef={strokeCanvasRef}
                peers={collabPeers}
                activePings={collabActivePings}
                remoteDraftCanvasesRef={remoteDraftCanvasesRef}
                tool={tool}
                liquifySettings={liquifySettings}
                onUpdateLiquifySettings={handleUpdateLiquifySettings}
                primaryColor={primaryColor}
                onSwapColors={handleSwapColors}
                selection={selection}
                onDeselect={handleDeselect}
                onTransformSelection={handleStartTransform}
                onFillScreentone={handleFillScreentone}
                onFillColor={handleFillSelectionColor}
                onClearSelection={handleClearSelection}
                onInvertSelection={handleInvertSelection}
                onExpandSelection={handleExpandSelection}
                onContractSelection={handleContractSelection}
                onFeatherSelection={handleFeatherSelection}
                transformSession={transformSession}
                onUpdateTransformSession={(updater) =>
                  setTransformSession((prev) => (prev ? updater(prev) : null))
                }
                onApplyTransform={handleApplyTransform}
                onCancelTransform={handleCancelTransform}
                textSession={textSession}
                onUpdateTextSettings={(updater) =>
                  setTextSession((prev) => (prev ? { ...prev, settings: updater(prev.settings) } : null))
                }
                onMoveTextSession={(newX, newY) =>
                  setTextSession((prev) => (prev ? { ...prev, x: newX, y: newY } : null))
                }
                onConfirmText={handleConfirmText}
                onCancelText={handleCancelText}
                perspectiveRuler={hasOpenDocument ? perspectiveRuler : null}
                onUpdatePerspectiveRuler={updatePerspectiveRuler}
                activeLockedAxis={activeLockedAxis}
                is3DLayerOpen={is3DLayerOpen}
                initial3DFile={initial3DFile}
                onClose3DLayer={() => {
                  setIs3DLayerOpen(false);
                  setInitial3DFile(null);
                }}
                onInsertRasterLayer={handleInsert3DRasterLayer}
                isWebtoonMode={isWebtoonMode}
                onToggleWebtoonMode={() => setIsWebtoonMode((prev) => !prev)}
                onOpenWebtoonExport={() => setIsWebtoonExportModalOpen(true)}
                activeBalloon={activeBalloon}
                onUpdateBalloon={(updater) => setActiveBalloon((prev) => (prev ? updater(prev) : null))}
                onConfirmBalloon={handleConfirmBalloon}
                onDeleteBalloon={handleDeleteBalloon}
                animationTimeline={activeAnimationTimeline}
                onUpdateAnimationTimeline={handleUpdateAnimationTimeline}
                onAddAnimationCel={handleAddAnimationCel}
                onDeleteAnimationCel={handleDeleteAnimationCel}
                onSelectCelLayer={setActiveLayerId}
                softProofSettings={softProofSettings}
              />
            </div>

            {!isRightSidebarHidden && (
              <RightSidebar
                hasOpenDocument={hasOpenDocument}
              onNewCanvas={() => setIsNewCanvasModalOpen(true)}
              onOpenFile={handleTriggerOpenFile}
              primaryColor={primaryColor}
              secondaryColor={secondaryColor}
              onPrimaryColorChange={handlePrimaryColorChange}
              onSecondaryColorChange={handleSecondaryColorChange}
              onSwapColors={handleSwapColors}
              recentColors={recentColors}
              currentTool={tool}
              onSelectTool={handleSelectTool}
              colorMode={colorMode}
              historyList={hasOpenDocument ? historyList : []}
              historyIndex={hasOpenDocument ? historyIndex : -1}
              onJumpToHistory={jumpToHistoryIndex}
              canUndo={hasOpenDocument && canUndo}
              canRedo={hasOpenDocument && canRedo}
              onUndo={handleUndo}
              onRedo={redo}
              layers={hasOpenDocument ? layers : []}
              activeLayerId={hasOpenDocument ? activeLayerId : ''}
              selectedLayerIds={hasOpenDocument ? selectedLayerIds : []}
              onSelectLayer={setActiveLayerId}
              onToggleLayerSelection={toggleLayerSelection}
              onGroupSelectedLayers={handleGroupSelectedLayers}
              onDeleteSelectedLayers={handleDeleteSelectedLayers}
              onAddLayer={handleAddLayer}
              onOpen3DLayer={hasOpenDocument ? () => setIs3DLayerOpen(true) : undefined}
              onDuplicateLayer={duplicateLayer}
              onDeleteLayer={handleDeleteLayer}
              onToggleVisibility={handleToggleVisibility}
              onSetOpacity={handleSetOpacity}
              onSetBlendMode={setBlendMode}
              onToggleLock={toggleLock}
              onToggleAlphaLock={toggleAlphaLock}
              onToggleClipping={toggleClipping}
              onToggleCollapse={toggleCollapse}
              onRenameLayer={handleRenameLayer}
              onMoveLayer={moveLayer}
              onMoveLayerToFolder={moveLayerToFolder}
              onReorderLayers={reorderLayers}
              onToggleReferenceLayer={handleToggleReferenceLayer}
              onToggleTone={toggleTone}
              onSetToneFrequency={setToneFrequency}
              onSetToneAngle={setToneAngle}
              onSetToneDotShape={setToneDotShape}
              onSetToneDensity={setToneDensity}
              onSetToneDensityType={setToneDensityType}
              onToggleLayerColor={toggleLayerColor}
              onSetLayerColor={setLayerColor}
              onSetLayerSubColor={setLayerSubColor}
              onSetLayerExpressionColor={setLayerExpressionColor}
              onSetLayerMonoThreshold={setLayerMonoThreshold}
              onSetLayerMonoExpressMode={setLayerMonoExpressMode}
              onApplyExpressionColor={handleApplyExpressionColor}
              onApplyLayerColor={handleApplyLayerColor}
              activeEditTarget={activeEditTarget}
              onSelectEditTarget={setActiveEditTarget}
              onAddLayerMask={addLayerMask}
              onRemoveLayerMask={removeLayerMask}
              onToggleLayerMask={toggleLayerMask}
              onToggleMaskLinked={toggleMaskLinked}
              onOpenAdjustmentModal={handleOpenAdjustmentModal}
              onOpenLayerStylesModal={handleOpenLayerStylesModal}
              width={rightSidebarWidth}
              onWidthChange={handleRightSidebarWidthChange}
            />
            )}
          </>
        )}
      </div>

      {/* Fault-Tolerant Crash Recovery Modal */}
      <CrashRecoveryModal
        isOpen={isRecoveryModalOpen}
        sessions={crashedSessions}
        onRestore={handleRestoreCrashedSession}
        onDiscard={handleDiscardCrashedSession}
        onClose={() => setIsRecoveryModalOpen(false)}
      />

      {/* New Canvas Modal Dialog */}
      <NewCanvasModal
        isOpen={isNewCanvasModalOpen}
        onClose={() => setIsNewCanvasModalOpen(false)}
        onCreate={handleCreateNewCanvas}
        initialWidth={dimensions.width}
        initialHeight={dimensions.height}
        initialDpi={dimensions.dpi || 300}
        initialName="Untitled*"
      />

      {/* Resize Canvas Modal Dialog */}
      <ResizeCanvasModal
        isOpen={isResizeCanvasModalOpen}
        onClose={() => setIsResizeCanvasModalOpen(false)}
        currentDimensions={dimensions}
        onResize={handleResizeCanvas}
      />

      {/* Settings Modal Dialog */}
      <SettingsModal
        isOpen={isSettingsModalOpen}
        onClose={() => setIsSettingsModalOpen(false)}
        settings={appSettings}
        onUpdateSettings={handleUpdateSettings}
        onShowToast={showToast}
      />

      {/* Tonal Correction Modal Dialog */}
      <TonalCorrectionModal
        isOpen={tonalModalState.isOpen}
        type={tonalModalState.type}
        beforeImageData={tonalModalState.beforeImageData}
        selectionMask={tonalModalState.selectionMask}
        onClose={handleTonalCancel}
        onApply={handleTonalApply}
        onPreviewChange={handleTonalPreviewChange}
      />

      {/* Non-destructive Adjustment Layer Modal (Curves, Gradient Map, Levels, Color Balance) */}
      {adjustmentModalState.isOpen && (
        <AdjustmentModal
          isOpen={adjustmentModalState.isOpen}
          initialType={adjustmentModalState.initialType || 'curves'}
          initialData={
            adjustmentModalState.layerId
              ? layers.find((l) => l.id === adjustmentModalState.layerId)?.adjustmentData
              : undefined
          }
          editingLayerId={adjustmentModalState.layerId}
          onApply={handleApplyAdjustment}
          onClose={() => setAdjustmentModalState({ isOpen: false })}
        />
      )}

      {/* Non-destructive GPU Layer Styles Modal (Stroke, Drop Shadow, Outer Glow) */}
      {layerStylesModalState.isOpen && (
        <LayerStylesModal
          isOpen={layerStylesModalState.isOpen}
          layerName={layers.find((l) => l.id === layerStylesModalState.layerId)?.name || 'Layer'}
          initialStyles={layers.find((l) => l.id === layerStylesModalState.layerId)?.styles}
          onClose={() => setLayerStylesModalState({ isOpen: false })}
          onApply={handleApplyLayerStyles}
        />
      )}

      {/* Clip Studio Paint Simple Tone Settings Modal */}
      <SimpleToneModal
        isOpen={isToneModalOpen}
        onClose={() => setIsToneModalOpen(false)}
        onConfirm={handleConfirmTone}
        initialFrequency={activeLayer?.toneFrequency || documents.find((d) => d.id === activeDocumentId)?.defaultFrequency || 60}
        initialDensity={activeLayer?.toneDensity || 40}
        dpi={dimensions.dpi ?? 600}
      />

      {/* Multiplayer Collaboration Modals & Overlays */}
      <HostModal
        isOpen={isHostModalOpen}
        onClose={() => setIsHostModalOpen(false)}
        isHost={isCollabHost}
        isConnected={isCollabConnected}
        hostInfo={collabHostInfo}
        peers={collabPeers}
        myPeer={collabMyPeer}
        onUpdateMyName={updateMyName}
        onStartHosting={handleStartHosting}
        onStopHosting={stopHosting}
        showToast={showToast}
      />

      <ClipboardInviteToast
        invite={clipboardInvite}
        onJoin={(h, p, r) => joinRoom(h, p, r, collabMyPeer.name)}
        onDismiss={() => setClipboardInvite(null)}
      />

      <WebLandingModal
        invite={webLandingInvite}
        onJoinInBrowser={(name, h, p, r) => {
          updateMyName(name);
          joinRoom(h, p, r, name);
        }}
        onDismiss={() => setWebLandingInvite(null)}
      />


      {/* Loading Modal when parsing large PSD or CSP files */}
      {isLoadingFile && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 select-none">
          <div className="bg-[#202020] rounded-md shadow-[0_16px_48px_rgba(0,0,0,0.75)] px-5 py-3.5 flex items-center gap-3 text-xs text-[#e5e5e5]">
            <Loader2 className="w-4 h-4 text-[var(--accent)] animate-spin" />
            <div className="flex flex-col">
              <span className="font-medium text-xs">{loadingStatus || 'Opening Document...'}</span>
              <span className="text-[#8a8a8a] text-[10px]">Extracting layers and pixel data</span>
            </div>
          </div>
        </div>
      )}

      {/* Toast Notification */}
      {toastMessage && (
        <div className="fixed bottom-5 right-5 z-50 bg-[#202020] text-[#e5e5e5] px-3.5 py-2 rounded-md shadow-[0_12px_32px_rgba(0,0,0,0.65)] flex items-center gap-2 text-xs">
          <CheckCircle2 className="w-3.5 h-3.5 text-[var(--accent)]" />
          <span className="font-medium">{toastMessage}</span>
        </div>
      )}

      {/* Manga Effect Lines Generator Modal */}
      <MangaEffectsModal
        isOpen={isMangaEffectsModalOpen}
        onClose={() => setIsMangaEffectsModalOpen(false)}
        canvasWidth={dimensions.width}
        canvasHeight={dimensions.height}
        onApply={handleApplyMangaEffects}
      />

      {/* Webtoon Chapter Slicer & Zip Exporter Modal */}
      <WebtoonExportModal
        isOpen={isWebtoonExportModalOpen}
        onClose={() => setIsWebtoonExportModalOpen(false)}
        getActiveCanvas={() =>
          compositeCanvas(
            dimensions,
            layers,
            layerCanvasesRef.current,
            getEffectiveOpacity,
            isLayerEffectivelyVisible,
            false
          )
        }
        canvasWidth={dimensions.width}
        canvasHeight={dimensions.height}
        documentTitle={documents.find((d) => d.id === activeDocumentId)?.name || 'webtoon_chapter'}
      />
    </div>
  );
}

export default App;
