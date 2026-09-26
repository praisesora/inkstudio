import { useState, useCallback, useEffect, useRef } from 'react';
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
} from './types/editor';
import { applyLiquifyStep, createLiquifySelectionMask, DirtyRect } from './utils/liquifyEngine';
import { PerspectiveRuler, ConstraintAxis } from './types/perspective';
import { createDefaultPerspectiveRuler, applyWormsEyePreset } from './utils/perspectiveMath';
import { executeFloodFill, compositeVisibleLayers, executeLassoFill } from './utils/floodFill';
import {
  isPointInSelection,
  liftSelectionToFloating,
  commitFloatingSelection,
  computePolygonBounds,
  getCanvasContentBounds,
} from './utils/selectionUtils';
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
  SaveDocumentData,
  SavedFileInfo,
} from './utils/saveManager';
import { Header } from './components/Header';
import { DocumentTabBar } from './components/DocumentTabBar';
import { LeftPanel } from './components/LeftPanel';
import { CanvasArea } from './components/CanvasArea';
import { RightSidebar } from './components/RightSidebar';
import { StatusBar } from './components/StatusBar';
import { NewCanvasModal } from './components/NewCanvasModal';
import { ResizeCanvasModal } from './components/ResizeCanvasModal';
import { SettingsModal } from './components/SettingsModal';
import { useMultiplayer } from './hooks/useMultiplayer';
import { multiplayerService } from './services/multiplayerService';
import { HostModal } from './components/HostModal';
import { ClipboardInviteToast } from './components/ClipboardInviteToast';
import { WebLandingModal } from './components/WebLandingModal';
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
import { getNextCollabLayerName } from './hooks/useLayerManager';
import { drawPencilDot, drawPencilBezierSegment, PencilGrade } from './utils/pencilEngine';
import { Point } from './types/editor';
import {
  StrokeStartMessage,
  StrokeChunkMessage,
  StrokeFinishMessage,
  MultiplayerMessage,
} from './types/multiplayer';

import { AppSettings, loadAppSettings, saveAppSettings, ResizeCanvasOptions } from './types/settings';
import {
  FilePlus,
  FolderOpen,
  Save,
  Download,
  Trash2,
  Undo2,
  Redo2,
  ZoomIn,
  ZoomOut,
  RotateCcw,
  Plus,
  Loader2,
  Sparkles,
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
} from 'lucide-react';
import { parseSutFile } from './utils/sutParser';
import {
  saveCustomBrush,
  prepareBrushSettingsForCsp,
  deleteCustomBrush,
  loadCustomBrushes,
} from './utils/brushStorage';
import {
  saveBrushSettingsImmediately,
  getEffectiveBrushSettings,
  getActivePresetId,
  saveActivePresetId,
  ERASER_PRESET_ID,
  DEFAULT_BRUSH_PRESET_ID,
} from './utils/brushPresetManager';
import { TonalCorrectionModal } from './components/TonalCorrectionModal';
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

  // Multi-document tab management (starts empty by default)
  const [documents, setDocuments] = useState<DocumentTab[]>([]);
  const [activeDocumentId, setActiveDocumentId] = useState<string | null>(null);
  const hasOpenDocument = Boolean(activeDocumentId && documents.some((d) => d.id === activeDocumentId));

  // Panels width & visibility (global resizability)
  const [leftPanelWidth, setLeftPanelWidth] = useState<number>(() => {
    const s = localStorage.getItem('sora_paint_left_panel_width');
    return s ? Number(s) : 260;
  });
  const [isLeftPanelHidden, setIsLeftPanelHidden] = useState<boolean>(false);
  const [rightSidebarWidth, setRightSidebarWidth] = useState<number>(() => {
    const s = localStorage.getItem('sora_paint_right_sidebar_width');
    return s ? Number(s) : 320;
  });

  const handleLeftPanelWidthChange = useCallback((w: number) => {
    setLeftPanelWidth(w);
    localStorage.setItem('sora_paint_left_panel_width', String(w));
  }, []);

  const handleRightSidebarWidthChange = useCallback((w: number) => {
    setRightSidebarWidth(w);
    localStorage.setItem('sora_paint_right_sidebar_width', String(w));
  }, []);

  const draftCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const strokeCanvasRef = draftCanvasRef; // Backwards-compatible alias

  const [savedFileInfo, setSavedFileInfo] = useState<SavedFileInfo | null>(null);
  const [toastMessage, setToastMessage] = useState<string | null>(null);
  const toastTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const [appSettings, setAppSettings] = useState<AppSettings>(loadAppSettings);

  useEffect(() => {
    const theme = appSettings.themePreset || 'vintage-manga';
    document.documentElement.setAttribute('data-theme', theme);
  }, [appSettings.themePreset]);

  const [isNewCanvasModalOpen, setIsNewCanvasModalOpen] = useState<boolean>(false);
  const [isResizeCanvasModalOpen, setIsResizeCanvasModalOpen] = useState<boolean>(false);
  const [isSettingsModalOpen, setIsSettingsModalOpen] = useState<boolean>(false);
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

  const fileInputRef = useRef<HTMLInputElement>(null);
  const pasteFileInputRef = useRef<HTMLInputElement>(null);
  const import3DFileInputRef = useRef<HTMLInputElement>(null);
  const [initial3DFile, setInitial3DFile] = useState<File | null>(null);

  const [perspectiveRuler, setPerspectiveRuler] = useState<PerspectiveRuler | null>(null);
  const [activeLockedAxis, setActiveLockedAxis] = useState<ConstraintAxis | null>(null);

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
    activeLayerId,
    setActiveLayerId,
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
    toggleLayerColor,
    setLayerColor,
    setLayerSubColor,
    setLayerExpressionColor,
    setLayerMonoThreshold,
    setLayerMonoExpressMode,
    applyExpressionColorOfPreview,
    applyLayerColorPermanently,
    convertLayer,
    fillScreentoneSelection,
  } = useLayerManager({ dimensions });

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
    const isBgEraser = isEraser && msg.layerId === 'layer-bg';
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
    const isBgEraser = isEraser && strokeState.layerId === 'layer-bg';
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
      const ctx = get2DContext(targetCanvas);
      if (ctx) {
        const isEraser = strokeState.tool === 'eraser';
        const isBgEraser = isEraser && (targetLayerId === 'layer-bg' || targetLayerId.startsWith('layer-bg'));
        const bs = strokeState.brushSettings;
        const isTranslucentBrush = !isEraser && (bs.opacity ?? 1.0) < 0.999;

        if (isTranslucentBrush) {
          const bakeCanvas = getReusableBakeCanvas(targetCanvas.width, targetCanvas.height);
          const bCtx = get2DContext(bakeCanvas);
          if (bCtx) {
            bCtx.clearRect(0, 0, targetCanvas.width, targetCanvas.height);
            renderCompleteStroke(
              bCtx,
              strokeState.points,
              bs,
              strokeState.tool,
              colorMode,
              isBgEraser
            );
            ctx.save();
            ctx.globalAlpha = Math.max(0.01, Math.min(1.0, bs.opacity ?? 1.0));
            ctx.globalCompositeOperation = 'source-over';
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
            isBgEraser
          );
        }

        updateLayerThumbnail(targetLayerId, true);
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
    // Automatically allocate a dedicated layer for the joining peer: "[Name] 1", "[Name] 2", etc.
    const layerName = getNextCollabLayerName(peer.name, layersRef.current);
    const layerId = `layer-${peer.id}-1`;
    const newLayer = addLayer('raster', null, layerName, layerId);
    multiplayerService.sendLayerAdd(newLayer);
    const updated = [newLayer, ...layersRef.current.filter((l) => l.id !== newLayer.id)];
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
          if (layerId === 'layer-bg' || layerId.startsWith('layer-bg')) {
            ctx.fillStyle = '#ffffff';
            ctx.fillRect(0, 0, targetCanvas.width, targetCanvas.height);
          } else {
            ctx.clearRect(0, 0, targetCanvas.width, targetCanvas.height);
          }
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
    showToast,
  });

  // When hosting starts, ensure host's primary drawing layer has the host's nickname
  const handleStartHosting = useCallback(
    async (roomName: string, port: number, hostNickname?: string) => {
      if (!hasOpenDocument) {
        showToast('Please create or open a canvas before hosting a session.');
        return false;
      }
      const finalHostName = (hostNickname || collabMyPeer.name || 'Sora').trim();
      const defaultLayer =
        layersRef.current.find((l) => l.id === activeLayerId) ||
        layersRef.current.find((l) => l.type === 'raster' && l.id !== 'layer-bg');
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
      return await startHosting(roomName, port, finalHostName);
    },
    [collabMyPeer.name, activeLayerId, renameLayer, startHosting]
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
    cursorPos,
    currentPressure,
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
    activeLayerLocked: activeLayer?.locked ?? false,
    activeLayerVisible: activeLayer ? isLayerEffectivelyVisible(activeLayer) : true,
    layerCanvasesRef,
    layerSourceCanvasesRef,
    layers: hasOpenDocument ? layers : [],
    onUpdateLayerThumbnail: updateLayerThumbnail,
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
    onCollabStrokeFinish: (strokeId, layerId, endPt, dirty) => {
      if (multiplayerService.isConnected()) {
        multiplayerService.sendStrokeFinish(strokeId, layerId, endPt, dirty);
      }
    },
    onCollabCursorMove: (x, y, isDrawing, t) => {
      if (multiplayerService.isConnected()) {
        multiplayerService.sendCursor(x, y, isDrawing, t);
      }
    },
    perspectiveRuler: hasOpenDocument ? perspectiveRuler : null,
    onActiveConstraintAxisChange: setActiveLockedAxis,
  });


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

      saveBrushSettingsImmediately(targetPresetId, next);
      if (next.preset && toolRef.current === 'brush') {
        saveActivePresetId(next.preset);
      }
      return next;
    });
  }, []);

  const handleBrushSizeChange = useCallback(
    (size: number) => {
      updateBrushSettings({ size });
    },
    [updateBrushSettings]
  );

  const addRecentColor = useCallback((color: string) => {
    setRecentColors((prev) => {
      const filtered = prev.filter((c) => c.toLowerCase() !== color.toLowerCase());
      return [color, ...filtered].slice(0, 14);
    });
  }, []);

  const handlePrimaryColorChange = useCallback(
    (color: string, commit = true) => {
      const effective = enforceColorMode(color, colorMode);
      setPrimaryColor(effective);
      updateBrushSettings({ color: effective });
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
      if (commit) {
        addRecentColor(effective);
      }
    },
    [addRecentColor, colorMode]
  );

  const handleSwapColors = useCallback(() => {
    setPrimaryColor((prevPrim) => {
      setSecondaryColor(prevPrim);
      const effective = enforceColorMode(secondaryColor, colorMode);
      updateBrushSettings({ color: effective });
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
    if (ctx && selection.floating.beforeImageData) {
      const afterData = ctx.getImageData(0, 0, canvas.width, canvas.height);
      pushHistoryStep(
        'selection-move',
        'Move Selection',
        selection.floating.beforeImageData,
        afterData,
        targetLayerId
      );
    }

    updateLayerThumbnail(targetLayerId, true);
    setSelection((prev) => (prev ? { ...prev, floating: null } : null));
  }, [selection, activeLayerId, layerCanvasesRef, getActiveCanvas, layerSourceCanvasesRef, pushHistoryStep, updateLayerThumbnail]);

  const handleDeselect = useCallback(() => {
    if (selection?.floating) {
      handleCommitFloatingSelection();
    }
    setSelection(null);
  }, [selection, handleCommitFloatingSelection]);

  const handleClearSelection = useCallback(() => {
    if (!selection) return;
    if (selection.floating) {
      setSelection(null);
      return;
    }

    const canvas = getActiveCanvas();
    if (!canvas) return;
    const ctx = get2DContext(canvas);
    if (!ctx) return;

    const beforeImageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const sourceCanvas = layerSourceCanvasesRef.current?.get(activeLayerId);

    const clearOn = (target: HTMLCanvasElement) => {
      const c = get2DContext(target);
      if (!c) return;
      c.save();
      if (selection.type === 'rect') {
        if (activeLayerId === 'layer-bg') {
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
        if (activeLayerId === 'layer-bg') {
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
  }, [selection, getActiveCanvas, activeLayerId, layerSourceCanvasesRef, updateLayerThumbnail, pushHistoryStep]);

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

  const handleInvertSelection = useCallback(() => {
    if (!selection) return;
    setSelection({
      type: 'rect',
      bounds: { x: 0, y: 0, width: dimensions.width, height: dimensions.height },
    });
    showToast('Inverted Selection');
  }, [selection, dimensions, showToast]);

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
    },
    [layers, layerCanvasesRef, layerSourceCanvasesRef, dimensions.dpi]
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
  }, [layers, layerCanvasesRef, layerSourceCanvasesRef, dimensions.dpi]);

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
        updateLayerThumbnail(activeLayerId, true);
      }

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
      });
      setSelection(null);
    } else {
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

      updateLayerThumbnail(activeLayerId, true);

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
      });
    }
    setTool('transform');
  }, [transformSession, getActiveCanvas, selection, activeLayerId, layerSourceCanvasesRef, updateLayerThumbnail, showToast]);

  const handleApplyTransform = useCallback(() => {
    if (!transformSession) return;
    const canvas = layerCanvasesRef.current.get(transformSession.layerId) || getActiveCanvas();
    if (!canvas) return;
    const ctx = get2DContext(canvas);
    if (!ctx) return;

    ctx.save();
    const cx = transformSession.x + transformSession.width / 2;
    const cy = transformSession.y + transformSession.height / 2;
    ctx.translate(cx, cy);
    ctx.rotate((transformSession.rotation * Math.PI) / 180);
    ctx.scale(transformSession.flipH ? -1 : 1, transformSession.flipV ? -1 : 1);
    ctx.drawImage(
      transformSession.sourceCanvas,
      -transformSession.width / 2,
      -transformSession.height / 2,
      transformSession.width,
      transformSession.height
    );
    ctx.restore();

    const sourceCanvas = layerSourceCanvasesRef.current?.get(transformSession.layerId);
    if (sourceCanvas) {
      const sCtx = get2DContext(sourceCanvas);
      if (sCtx) {
        sCtx.save();
        sCtx.translate(cx, cy);
        sCtx.rotate((transformSession.rotation * Math.PI) / 180);
        sCtx.scale(transformSession.flipH ? -1 : 1, transformSession.flipV ? -1 : 1);
        sCtx.drawImage(
          transformSession.sourceCanvas,
          -transformSession.width / 2,
          -transformSession.height / 2,
          transformSession.width,
          transformSession.height
        );
        sCtx.restore();
      }

      const layer = layers.find((l) => l.id === transformSession.layerId);
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

    const afterImageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
    pushHistoryStep(
      'transform',
      'Free Transform',
      transformSession.beforeImageData,
      afterImageData,
      transformSession.layerId
    );

    updateLayerThumbnail(transformSession.layerId, true);
    setTransformSession(null);
    setTool('brush');
  }, [
    transformSession,
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
    const canvas = layerCanvasesRef.current.get(transformSession.layerId) || getActiveCanvas();
    if (canvas && transformSession.beforeImageData) {
      const ctx = get2DContext(canvas);
      ctx?.putImageData(transformSession.beforeImageData, 0, 0);

      const sourceCanvas = layerSourceCanvasesRef.current?.get(transformSession.layerId);
      if (sourceCanvas) {
        const sCtx = get2DContext(sourceCanvas);
        sCtx?.putImageData(transformSession.beforeImageData, 0, 0);

        const layer = layers.find((l) => l.id === transformSession.layerId);
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
      updateLayerThumbnail(transformSession.layerId, true);
    }
    setTransformSession(null);
    setTool('brush');
  }, [
    transformSession,
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
      const lines = s.text.split('\n');
      const fontSize = s.fontSize;
      const fontStyle = `${s.italic ? 'italic ' : ''}${s.bold ? 'bold ' : ''}${fontSize}px ${s.fontFamily}`;

      c.save();
      c.font = fontStyle;
      c.textAlign = s.align;
      c.textBaseline = 'middle';

      const lineHeight = fontSize * 1.25;
      const totalH = lines.length * lineHeight;
      const startY = textSession.y - totalH / 2 + lineHeight / 2;

      lines.forEach((line, i) => {
        const lineY = startY + i * lineHeight;
        if (s.outline && s.outlineWidth > 0) {
          c.strokeStyle = s.outlineColor;
          c.lineWidth = s.outlineWidth * 2;
          c.lineJoin = 'round';
          c.miterLimit = 2;
          c.strokeText(line, textSession.x, lineY);
        }
        c.fillStyle = s.color;
        c.fillText(line, textSession.x, lineY);
      });
      c.restore();
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

    setTextSession(null);
  }, [textSession, getActiveCanvas, activeLayerId, layerSourceCanvasesRef, updateLayerThumbnail, pushHistoryStep]);

  const handleCancelText = useCallback(() => {
    setTextSession(null);
  }, []);

  const handleInsert3DRasterLayer = useCallback(
    (layer: LayerItem, canvas: HTMLCanvasElement) => {
      pasteLayerFromCanvas(canvas, layer.name, layer.blendMode, layer.opacity, layer.id);
      showToast(`Baked 3D scene into raster layer "${layer.name}".`);
    },
    [pasteLayerFromCanvas, showToast]
  );

  const handleFillScreentone = useCallback(() => {
    if (!selection) return;

    const { id, canvas } = fillScreentoneSelection(selection);
    const ctx = get2DContext(canvas);
    if (ctx) {
      const afterData = ctx.getImageData(0, 0, canvas.width, canvas.height);
      pushHistoryStep('screentone', 'Screentone Fill', null, afterData, id);
    }
    showToast('Created Screentone Layer');
  }, [selection, fillScreentoneSelection, pushHistoryStep, showToast]);

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
          }
        }

        liquifyRafIdRef.current = requestAnimationFrame(tick);
      };

      liquifyRafIdRef.current = requestAnimationFrame(tick);
    },
    [activeLayer, activeLayerId, dimensions.dpi, layerCanvasesRef]
  );

  const handlePointerDown = useCallback(
    (e: React.PointerEvent<HTMLElement>) => {
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
        if (!liquifyInitialImageDataRef.current) {
          liquifyInitialImageDataRef.current = liquifyBeforeImageDataRef.current;
        }
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
            }
          }
          startLiquifyLoop(canvas, sourceCanvas, isTone);
        }
        return;
      }

      if (tool === 'brush' || tool === 'eraser') {
        if (selection?.floating) {
          handleCommitFloatingSelection();
        }
        handleCanvasDrawingPointerDown(e);
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
        } else {
          refCanvas = canvas;
        }

        const fillRes = executeFloodFill(canvas, refCanvas, px, py, primaryColor, fillSettings.tolerance, sourceCanvas);
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
    ]
  );

  const handlePointerMove = useCallback(
    (e: React.PointerEvent<HTMLElement>) => {
      if (tool === 'pipette') {
        if (isPipetteSamplingRef.current) {
          const pt = getCanvasCoords(e);
          handleSampleColor(pt);
        }
        return;
      }

      if (tool === 'brush' || tool === 'eraser') {
        handleCanvasDrawingPointerMove(e);
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
          }
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
    [tool, handleCanvasDrawingPointerMove, getCanvasCoords, fillSettings.method, handleSampleColor]
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
              updateLayerThumbnail(targetLayerId, true);
            }
          }

          liquifyBeforeImageDataRef.current = null;
          liquifySelectionMaskRef.current = null;
          liquifyDirtyRectRef.current = null;
          prevLiquifyPointRef.current = null;
          liquifyLastPointerPosRef.current = null;
        }
        return;
      }

      const pt = getCanvasCoords(e);

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
        }
        return;
      }
    },
    [
      tool,
      handleCanvasDrawingPointerUp,
      getCanvasCoords,
      selection,
      fillSettings.method,
      getActiveCanvas,
      layerSourceCanvasesRef,
      activeLayerId,
      primaryColor,
      updateLayerThumbnail,
      pushHistoryStep,
      frameSettings,
      handleSampleColor,
    ]
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
      resetZoomAndCenter();
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
      showToast(`Created ${name}`);
    },
    [primaryColor, resetHistory, resetToNewCanvas, resetZoomAndCenter, showToast, updateBrushSettings]
  );

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
      resetZoomAndCenter();
      resetHistory();
      showToast(`Canvas resized to ${newDims.width} × ${newDims.height} px`);
    },
    [dimensions.dpi, resetHistory, resetZoomAndCenter, resizeCanvas, showToast]
  );

  // Settings update handler
  const handleUpdateSettings = useCallback((newSettings: AppSettings) => {
    setAppSettings(newSettings);
    saveAppSettings(newSettings);
    setBrushSettings((prev) => ({
      ...prev,
      stabilization: newSettings.defaultStabilization,
      usePressure: newSettings.usePressureByDefault,
      smoothing: newSettings.smoothingEnabled,
    }));
  }, []);

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
        resetZoomAndCenter();
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
      if (curr.layers === layers && curr.activeLayerId === activeLayerId) {
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
      resetZoomAndCenter();
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
          }
        }
        return next;
      });
    },
    [activeDocumentId, clearDocument, loadDocument, resetHistory]
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
    };

    // If haven't saved the file yet, prompt to select a path and file extension
    if (!savedFileInfo?.handle) {
      try {
        const info = await promptSaveAs(docData, savedFileInfo?.extension || '.png');
        setSavedFileInfo(info);
        // info.name includes the extension (e.g. art.png or Untitled.png)
        setDocumentName(info.name);
        setDocuments((prev) =>
          prev.map((d) => (d.id === activeDocumentId ? { ...d, name: info.name, savedFileInfo: info } : d))
        );
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
        showToast(`Saved to ${savedFileInfo.name}`);
      } catch (err: any) {
        console.warn('Direct handle save failed, prompting with Save As:', err);
        try {
          const info = await promptSaveAs(docData, savedFileInfo.extension || '.png');
          setSavedFileInfo(info);
          setDocumentName(info.name);
          setDocuments((prev) =>
            prev.map((d) => (d.id === activeDocumentId ? { ...d, name: info.name, savedFileInfo: info } : d))
          );
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
    };

    try {
      const defaultExt = savedFileInfo?.extension || '.png';
      const info = await promptSaveAs(docData, defaultExt);
      setSavedFileInfo(info);
      setDocumentName(info.name);
      setDocuments((prev) =>
        prev.map((d) => (d.id === activeDocumentId ? { ...d, name: info.name, savedFileInfo: info } : d))
      );
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

  // Global Keyboard Shortcuts (Ctrl+N, Ctrl+O, Ctrl+S, Ctrl+Shift+S, B, E, X)
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (['INPUT', 'TEXTAREA'].includes((e.target as HTMLElement).tagName)) {
        return;
      }

      const key = e.key.toLowerCase();

      // Ctrl / Cmd shortcuts
      if (e.ctrlKey || e.metaKey) {
        // Undo: Ctrl+Z (Cmd+Z)
        if (!e.shiftKey && (key === 'z' || e.code === 'KeyZ')) {
          if (!hasOpenDocument) return;
          e.preventDefault();
          undo();
          return;
        }
        // Redo: Ctrl+Shift+Z or Ctrl+Y
        if (
          (e.shiftKey && (key === 'z' || e.code === 'KeyZ')) ||
          (!e.shiftKey && (key === 'y' || e.code === 'KeyY'))
        ) {
          if (!hasOpenDocument) return;
          e.preventDefault();
          redo();
          return;
        }
        if (!e.shiftKey && key === 'n') {
          e.preventDefault();
          setIsNewCanvasModalOpen(true);
          return;
        }
        if (!e.shiftKey && key === 'o') {
          e.preventDefault();
          handleTriggerOpenFile();
          return;
        }
        // Save As: Ctrl+Shift+S
        if (e.shiftKey && key === 's') {
          if (!hasOpenDocument) return;
          e.preventDefault();
          handleSaveAs();
          return;
        }
        // Save: Ctrl+S
        if (!e.shiftKey && key === 's') {
          if (!hasOpenDocument) return;
          e.preventDefault();
          handleSave();
          return;
        }
        // Copy Layer: Ctrl+C (only when no text is selected)
        if (!e.shiftKey && key === 'c') {
          if (!hasOpenDocument) return;
          const selection = window.getSelection()?.toString();
          if (!selection || selection.length === 0) {
            e.preventDefault();
            handleCopySelectedLayer();
            return;
          }
        }
        // Paste Layer: Ctrl+V
        if (!e.shiftKey && key === 'v') {
          if (!hasOpenDocument) return;
          e.preventDefault();
          handlePasteSelectedLayer();
          return;
        }
        // Transform: Ctrl+T
        if (!e.shiftKey && (key === 't' || e.code === 'KeyT')) {
          if (!hasOpenDocument) return;
          e.preventDefault();
          handleStartTransform();
          return;
        }
        // Deselect: Ctrl+D
        if (!e.shiftKey && (key === 'd' || e.code === 'KeyD')) {
          if (!hasOpenDocument) return;
          e.preventDefault();
          handleDeselect();
          return;
        }
        // Invert Selection: Ctrl+Shift+I
        if (e.shiftKey && (key === 'i' || e.code === 'KeyI')) {
          if (!hasOpenDocument) return;
          e.preventDefault();
          handleInvertSelection();
          return;
        }
        // Reverse Gradient (Invert Colors): Ctrl+I
        if (!e.shiftKey && (key === 'i' || e.code === 'KeyI')) {
          if (!hasOpenDocument || !activeLayer || activeLayer.locked || activeLayer.type !== 'raster') return;
          e.preventDefault();
          handleApplyReverseGradient();
          return;
        }
        // Hue / Saturation / Luminosity: Ctrl+U
        if (!e.shiftKey && (key === 'u' || e.code === 'KeyU')) {
          if (!hasOpenDocument || !activeLayer || activeLayer.locked || activeLayer.type !== 'raster') return;
          e.preventDefault();
          handleOpenTonalModal('hue-saturation');
          return;
        }
        // Settings: Ctrl+,
        if (!e.shiftKey && (key === ',' || key === '<')) {
          e.preventDefault();
          setIsSettingsModalOpen(true);
          return;
        }
        // Toggle Perspective Ruler: Ctrl+Shift+R
        if (e.shiftKey && (key === 'r' || e.code === 'KeyR')) {
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
        if (e.shiftKey && (key === 'p' || e.code === 'KeyP')) {
          e.preventDefault();
          updatePerspectiveRuler((prev) => {
            if (!prev) return null;
            const next = { ...prev, snapEnabled: !prev.snapEnabled };
            showToast(next.snapEnabled ? 'Perspective Snapping: ON' : 'Perspective Snapping: OFF');
            return next;
          });
          return;
        }
      }

      // Tool shortcuts (without modifier keys)
      if (!e.ctrlKey && !e.metaKey && !e.altKey) {
        if (key === 'b') {
          handleSelectTool('brush');
        } else if (key === 'e') {
          handleSelectTool('eraser');
        } else if (key === 'm') {
          handleSelectTool('select-rect');
        } else if (key === 'l') {
          handleSelectTool('select-lasso');
        } else if (key === 'g') {
          handleSelectTool('fill');
        } else if (key === 't') {
          handleSelectTool('text');
        } else if (key === 'f') {
          handleSelectTool('frame');
        } else if (key === 'i') {
          handleSelectTool('pipette');
        } else if (key === 'j') {
          handleSelectTool('liquify');
        } else if (key === 'x') {
          handleSwapColors();
        } else if (key === '[') {
          setIsLeftPanelHidden((prev) => !prev);
        } else if (key === 'delete') {
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
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [
    handleCopySelectedLayer,
    handleDeleteSelectedLayer,
    handleExportImage,
    handlePasteSelectedLayer,
    handleSave,
    handleSaveAs,
    handleSwapColors,
    handleTriggerOpenFile,
    hasOpenDocument,
    activeLayer,
    redo,
    undo,
    handleStartTransform,
    handleDeselect,
    handleInvertSelection,
    handleClearSelection,
    handleCancelTransform,
    handleApplyTransform,
    handleCancelText,
    handleApplyReverseGradient,
    handleOpenTonalModal,
    selection,
    transformSession,
    textSession,
    handleSelectTool,
  ]);

  // Pipette tool: hold Alt to activate, release Alt to switch back to previous tool
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (['INPUT', 'TEXTAREA'].includes((e.target as HTMLElement).tagName)) {
        return;
      }

      if (e.key === 'Alt') {
        if (!e.ctrlKey && !e.metaKey) {
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

      // If user holds Ctrl while Alt is active (e.g. initiating Ctrl+Alt brush resize), revert pipette
      if ((e.ctrlKey || e.metaKey) && isAltActiveRef.current) {
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
  }, []);

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

  // Application Menu Bar Sections
  const menuSections: MenuSection[] = [
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
          onClick: undo,
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
                  label: `${count} Rays per VP${(perspectiveRuler.guideRayCount || 6) === count ? ' ✓' : ''}`,
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
      ],
    },
    {
      id: 'help',
      label: 'Help',
      items: [
        {
          id: 'help-about',
          label: 'About Ink Studio',
          icon: <Sparkles className="w-3.5 h-3.5 text-amber-400" />,
          onClick: () => {
            alert(
              'Ink Studio — Professional Digital Painting & Manga Studio\n\n' +
                '• Full Layer Management with 12 Blend Modes\n' +
                '• Supports Opening PSD (Photoshop) & CSP (Clip Studio Paint) with layers\n' +
                '• Supports Common Images: PNG, JPG, WEBP, GIF, BMP, SVG\n' +
                '• Save & Save As: PSD (layered), Ink Studio Project (.sora / .ink), PNG, JPG, WebP\n' +
                '• Export Image: High-resolution PNG\n' +
                '• Color Modes: Full Color (RGB), Grayscale, and 1-bit Manga Monochrome\n' +
                '• Tablet Pressure & Inking Stabilization'
            );
          },
        },
      ],
    },
  ];

  return (
    <div
      className="flex flex-col w-screen h-screen overflow-hidden bg-[#1e1e1e] text-[#cccccc] font-sans app-root-container"
      data-theme={appSettings.themePreset || 'vintage-manga'}
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

      {/* Top Application Bar */}
      <Header
        tool={tool}
        preset={brushSettings.preset}
        brushName={brushSettings.brushName}
        brushSize={brushSettings.size}
        onBrushSizeChange={handleBrushSizeChange}
        canUndo={hasOpenDocument && canUndo}
        canRedo={hasOpenDocument && canRedo}
        onUndo={undo}
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
        isCollabConnected={isCollabConnected}
        collabPeerCount={collabPeers.length + 1}
        onOpenCollabModal={() => setIsHostModalOpen(true)}
        themePreset={appSettings.themePreset}
        activeDocumentTitle={documents.find((d) => d.id === activeDocumentId)?.name}
      />


      {/* Main Workspace: Left Panel + Center Canvas Column + Right Sidebar */}
      <div className="flex flex-1 overflow-hidden relative">
        <LeftPanel
          currentTool={tool}
          onSelectTool={handleSelectTool}
          brushSettings={brushSettings}
          onUpdateBrushSettings={updateBrushSettings}
          primaryColor={primaryColor}
          secondaryColor={secondaryColor}
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
        />

        {/* Center Workspace: Document Tab Bar (Projects) + Canvas Area */}
        <div className="flex flex-col flex-1 min-w-0 overflow-hidden relative">
          <DocumentTabBar
            documents={documents}
            activeDocumentId={activeDocumentId}
            onSelectDocument={handleSelectDocument}
            onCloseDocument={handleCloseDocument}
            onNewDocument={() => setIsNewCanvasModalOpen(true)}
            onRenameDocument={handleRenameDocument}
            themePreset={appSettings.themePreset}
          />

          <CanvasArea
            viewportRef={viewportRef}
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
            registerLayerCanvas={registerLayerCanvas}
            getEffectiveOpacity={getEffectiveOpacity}
            isLayerEffectivelyVisible={isLayerEffectivelyVisible}
            interactionRef={interactionRef}
            showCheckerboard={appSettings.showCheckerboard}
            hasOpenDocument={hasOpenDocument}
            draftCanvasRef={draftCanvasRef}
            strokeCanvasRef={strokeCanvasRef}
            peers={collabPeers}
            activePings={collabActivePings}
            remoteDraftCanvasesRef={remoteDraftCanvasesRef}
            tool={tool}
            liquifySettings={liquifySettings}
            selection={selection}
            onDeselect={handleDeselect}
            onTransformSelection={handleStartTransform}
            onFillScreentone={handleFillScreentone}
            onFillColor={handleFillSelectionColor}
            onClearSelection={handleClearSelection}
            onInvertSelection={handleInvertSelection}
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
            onUpdatePerspectiveRuler={setPerspectiveRuler}
            activeLockedAxis={activeLockedAxis}
            is3DLayerOpen={is3DLayerOpen}
            initial3DFile={initial3DFile}
            onClose3DLayer={() => {
              setIs3DLayerOpen(false);
              setInitial3DFile(null);
            }}
            onInsertRasterLayer={handleInsert3DRasterLayer}
          />
        </div>

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
          onSelectTool={setTool}
          colorMode={colorMode}
          historyList={hasOpenDocument ? historyList : []}
          historyIndex={hasOpenDocument ? historyIndex : -1}
          onJumpToHistory={jumpToHistoryIndex}
          canUndo={hasOpenDocument && canUndo}
          canRedo={hasOpenDocument && canRedo}
          onUndo={undo}
          onRedo={redo}
          layers={hasOpenDocument ? layers : []}
          activeLayerId={hasOpenDocument ? activeLayerId : ''}
          onSelectLayer={setActiveLayerId}
          onAddLayer={handleAddLayer}
          onOpen3DLayer={hasOpenDocument ? () => setIs3DLayerOpen(true) : undefined}
          onDuplicateLayer={duplicateLayer}
          onDeleteLayer={handleDeleteLayer}
          onToggleVisibility={handleToggleVisibility}
          onSetOpacity={handleSetOpacity}
          onSetBlendMode={setBlendMode}
          onToggleLock={toggleLock}
          onToggleCollapse={toggleCollapse}
          onRenameLayer={handleRenameLayer}
          onMoveLayer={moveLayer}
          onMoveLayerToFolder={moveLayerToFolder}
          onReorderLayers={reorderLayers}
          onToggleTone={toggleTone}
          onSetToneFrequency={setToneFrequency}
          onSetToneAngle={setToneAngle}
          onSetToneDotShape={setToneDotShape}
          onToggleLayerColor={toggleLayerColor}
          onSetLayerColor={setLayerColor}
          onSetLayerSubColor={setLayerSubColor}
          onSetLayerExpressionColor={setLayerExpressionColor}
          onSetLayerMonoThreshold={setLayerMonoThreshold}
          onSetLayerMonoExpressMode={setLayerMonoExpressMode}
          onApplyExpressionColor={handleApplyExpressionColor}
          onApplyLayerColor={handleApplyLayerColor}
          width={rightSidebarWidth}
          onWidthChange={handleRightSidebarWidthChange}
        />
      </div>

      {/* Bottom Status Bar */}
      <StatusBar
        cursorPos={cursorPos}
        currentPressure={currentPressure}
        tool={tool}
        brushSettings={brushSettings}
        zoom={zoom}
        rotation={rotation}
        onResetRotation={resetRotation}
        colorMode={colorMode}
        showCursorCoordinates={appSettings.showCursorCoordinates}
        showPressureInStatusBar={appSettings.showPressureInStatusBar}
        hasOpenDocument={hasOpenDocument}
        themePreset={appSettings.themePreset}
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
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-xs select-none animate-in fade-in duration-100">
          <div className="bg-[#252528] border border-[#3e3e42] rounded-lg shadow-2xl px-6 py-4 flex items-center space-x-3 text-xs text-white">
            <Loader2 className="w-5 h-5 text-[#38bdf8] animate-spin" />
            <div className="flex flex-col">
              <span className="font-semibold text-sm">{loadingStatus || 'Opening Document...'}</span>
              <span className="text-[#888888] text-[11px]">Extracting layers, blend modes, and pixel data</span>
            </div>
          </div>
        </div>
      )}

      {/* Toast Notification */}
      {toastMessage && (
        <div className="fixed bottom-12 right-6 z-50 bg-[#252528] border border-[#007acc] text-white px-4 py-2.5 rounded-md shadow-2xl flex items-center space-x-2.5 text-xs animate-in slide-in-from-bottom-2 fade-in duration-150">
          <CheckCircle2 className="w-4 h-4 text-[#38bdf8]" />
          <span className="font-medium">{toastMessage}</span>
        </div>
      )}
    </div>
  );
}

export default App;
