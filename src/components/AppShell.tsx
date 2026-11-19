import React, { useMemo, useCallback, useEffect } from 'react';
import {
  AnimationTimeline,
  BlendMode,
  CanvasSelection,
  ExpressionColor,
  HistoryItemMeta,
  LayerItem,
  MenuSection,
  SpeechBalloon,
  TransformSession,
} from '../types/editor';
import { CollabPeer } from '../types/multiplayer';
import { SparseTileGrid } from '../utils/tileEngine';
import { RecentDocument } from '../utils/recentDocumentsManager';
import {
  getAccentContrastColor,
  hexToRgb,
  resolveModernAccentColor,
} from '../types/settings';
import { CanvasNavigationHandle } from '../hooks/useCanvasNavigation';
import { TextPlacementSession } from '../hooks/drawing/useShapeAndFillTools';
import {
  documentStoreActions,
  selectHasOpenDocument,
  toolStoreActions,
  uiStoreActions,
  useDocumentStore,
  useToolStore,
  useUiStore,
  useWorkspaceStore,
} from '../stores';
import { Header } from './Header';
import { WelcomeScreen } from './WelcomeScreen';
import { CanvasArea } from './CanvasArea';
import { DocumentTabBar } from './DocumentTabBar';
import { StatusBar } from './StatusBar';
import { DockWorkspace } from './DockWorkspace';
import { WorkspaceCommandHandlers } from './CommandBar';

interface CanvasAreaContainerProps {
  viewportRef: React.RefObject<HTMLDivElement | null>;
  onViewportReady: (viewport: HTMLDivElement) => void;
  zoom: number;
  pan: { x: number; y: number };
  rotation: number;
  flipX: boolean;
  flipY: boolean;
  navigation: CanvasNavigationHandle;
  isSpaceDown: boolean;
  isShiftDown: boolean;
  isRotateModifier: boolean;
  isPanning: boolean;
  isRotating: boolean;
  startPan: (e: React.PointerEvent) => void;
  startRotate: (e: React.PointerEvent) => void;
  isHovering: boolean;
  cursorPos: { x: number; y: number } | null;
  onPointerDown: (e: React.PointerEvent<HTMLElement>, coalescedEvents?: PointerEvent[]) => void;
  onPointerMove: (
    e: React.PointerEvent<HTMLElement>,
    coalescedEvents?: PointerEvent[],
    predictedEvents?: PointerEvent[]
  ) => void;
  onPointerUp: (e: React.PointerEvent<HTMLElement>) => void;
  onPointerEnter: () => void;
  onPointerLeave: () => void;
  layers: LayerItem[];
  activeLayerId: string;
  tileGrid: SparseTileGrid;
  layerCanvasesRef: React.MutableRefObject<Map<string, HTMLCanvasElement>>;
  registerLayerCanvas: (id: string, canvas: HTMLCanvasElement | null) => void;
  getEffectiveOpacity: (layer: LayerItem) => number;
  isLayerEffectivelyVisible: (layer: LayerItem) => boolean;
  interactionRef: React.RefObject<HTMLDivElement | null>;
  draftCanvasRef: React.RefObject<HTMLCanvasElement | null>;
  strokeCanvasRef: React.RefObject<HTMLCanvasElement | null>;
  peers: CollabPeer[];
  activePings: Array<{ id: string; x: number; y: number; color: string; name: string }>;
  remoteDraftCanvasesRef: React.MutableRefObject<Map<string | number, HTMLCanvasElement>>;
  selection: CanvasSelection | null;
  onDeselect: () => void;
  onTransformSelection: () => void;
  onFillScreentone: () => void;
  onFillColor: () => void;
  onClearSelection: () => void;
  onInvertSelection: () => void;
  onExpandSelection: (pixels?: number) => void;
  onContractSelection: (pixels?: number) => void;
  onFeatherSelection: (radius?: number) => void;
  transformSession: TransformSession | null;
  setTransformSession: React.Dispatch<React.SetStateAction<TransformSession | null>>;
  onApplyTransform: () => void;
  onCancelTransform: () => void;
  textSession: TextPlacementSession | null;
  setTextSession: React.Dispatch<React.SetStateAction<TextPlacementSession | null>>;
  onConfirmText: () => void;
  onCancelText: () => void;
  onInsertRasterLayer: (layer: LayerItem, canvas: HTMLCanvasElement) => void;
  activeBalloon: SpeechBalloon | null;
  setActiveBalloon: React.Dispatch<React.SetStateAction<SpeechBalloon | null>>;
  onConfirmBalloon: () => void;
  onDeleteBalloon: () => void;
  animationTimeline: AnimationTimeline | null;
  onUpdateAnimationTimeline: (timeline: AnimationTimeline | null) => void;
  onAddAnimationCel: (frameIndex: number) => void;
  onDeleteAnimationCel: (frameIndex: number) => void;
  onSelectCelLayer: (layerId: string) => void;
}

/**
 * Isolated store-connected CanvasArea wrapper so tool/brush/color changes only
 * re-render CanvasArea without re-rendering AppShell, Header, or RightSidebar.
 */
const CanvasAreaContainer: React.FC<CanvasAreaContainerProps> = React.memo((props) => {
  const tool = useToolStore((s) => s.tool);
  const brushSettings = useToolStore((s) => s.brushSettings);
  const liquifySettings = useToolStore((s) => s.liquifySettings);
  const primaryColor = useToolStore((s) => s.primaryColor);

  const dimensions = useDocumentStore((s) => s.dimensions);
  const colorMode = useDocumentStore((s) => s.colorMode);
  const hasOpenDocument = useDocumentStore(selectHasOpenDocument);
  const perspectiveRuler = useDocumentStore((s) => s.perspectiveRuler);
  const activeLockedAxis = useDocumentStore((s) => s.activeLockedAxis);
  const softProofSettings = useDocumentStore((s) => s.softProofSettings);

  const showCheckerboard = useUiStore((s) => s.appSettings.showCheckerboard);
  const showCursorCoordinates = useUiStore((s) => s.appSettings.showCursorCoordinates);
  const showPressureInStatusBar = useUiStore((s) => s.appSettings.showPressureInStatusBar);
  const is3DLayerOpen = useUiStore((s) => s.is3DLayerOpen);
  const initial3DFile = useUiStore((s) => s.initial3DFile);
  const isWebtoonMode = useUiStore((s) => s.isWebtoonMode);

  const handleClose3DLayer = useCallback(() => {
    uiStoreActions.set3DLayerOpen(false, null);
  }, []);

  const handleToggleWebtoon = useCallback(() => {
    uiStoreActions.toggleWebtoonMode();
  }, []);

  const handleOpenWebtoonExport = useCallback(() => {
    uiStoreActions.setWebtoonExportModalOpen(true);
  }, []);

  const handleUpdateTransformSession = useCallback(
    (updater: (prev: TransformSession) => TransformSession) => {
      props.setTransformSession((prev) => (prev ? updater(prev) : null));
    },
    [props.setTransformSession]
  );

  const handleUpdateTextSettings = useCallback(
    (updater: (prev: TextPlacementSession['settings']) => TextPlacementSession['settings']) => {
      props.setTextSession((prev) => (prev ? { ...prev, settings: updater(prev.settings) } : null));
    },
    [props.setTextSession]
  );

  const handleMoveTextSession = useCallback(
    (newX: number, newY: number) => {
      props.setTextSession((prev) => (prev ? { ...prev, x: newX, y: newY } : null));
    },
    [props.setTextSession]
  );

  const handleUpdateBalloon = useCallback(
    (updater: (prev: SpeechBalloon) => SpeechBalloon) => {
      props.setActiveBalloon((prev) => (prev ? updater(prev) : null));
    },
    [props.setActiveBalloon]
  );

  return (
    <CanvasArea
      viewportRef={props.viewportRef}
      onViewportReady={props.onViewportReady}
      dimensions={dimensions}
      brushSettings={brushSettings}
      onUpdateBrushSettings={toolStoreActions.updateBrushSettings}
      zoom={props.zoom}
      pan={props.pan}
      rotation={props.rotation}
      flipX={props.flipX}
      flipY={props.flipY}
      navigation={props.navigation}
      isSpaceDown={props.isSpaceDown}
      isShiftDown={props.isShiftDown}
      isRotateModifier={props.isRotateModifier}
      isPanning={props.isPanning}
      isRotating={props.isRotating}
      onStartPan={props.startPan}
      onStartRotate={props.startRotate}
      isHovering={props.isHovering}
      cursorPos={props.cursorPos}
      onPointerDown={props.onPointerDown}
      onPointerMove={props.onPointerMove}
      onPointerUp={props.onPointerUp}
      onPointerEnter={props.onPointerEnter}
      onPointerLeave={props.onPointerLeave}
      layers={props.layers}
      activeLayerId={props.activeLayerId}
      colorMode={colorMode}
      tileGrid={props.tileGrid}
      layerCanvasesRef={props.layerCanvasesRef}
      registerLayerCanvas={props.registerLayerCanvas}
      getEffectiveOpacity={props.getEffectiveOpacity}
      isLayerEffectivelyVisible={props.isLayerEffectivelyVisible}
      interactionRef={props.interactionRef}
      showCheckerboard={showCheckerboard}
      showCursorCoordinates={showCursorCoordinates}
      showPressureInStatusBar={showPressureInStatusBar}
      hasOpenDocument={hasOpenDocument}
      draftCanvasRef={props.draftCanvasRef}
      strokeCanvasRef={props.strokeCanvasRef}
      peers={props.peers}
      activePings={props.activePings}
      remoteDraftCanvasesRef={props.remoteDraftCanvasesRef}
      tool={tool}
      liquifySettings={liquifySettings}
      onUpdateLiquifySettings={toolStoreActions.updateLiquifySettings}
      primaryColor={primaryColor}
      onSwapColors={toolStoreActions.swapColors}
      selection={props.selection}
      onDeselect={props.onDeselect}
      onTransformSelection={props.onTransformSelection}
      onFillScreentone={props.onFillScreentone}
      onFillColor={props.onFillColor}
      onClearSelection={props.onClearSelection}
      onInvertSelection={props.onInvertSelection}
      onExpandSelection={props.onExpandSelection}
      onContractSelection={props.onContractSelection}
      onFeatherSelection={props.onFeatherSelection}
      transformSession={props.transformSession}
      onUpdateTransformSession={handleUpdateTransformSession}
      onApplyTransform={props.onApplyTransform}
      onCancelTransform={props.onCancelTransform}
      textSession={props.textSession}
      onUpdateTextSettings={handleUpdateTextSettings}
      onMoveTextSession={handleMoveTextSession}
      onConfirmText={props.onConfirmText}
      onCancelText={props.onCancelText}
      perspectiveRuler={hasOpenDocument ? perspectiveRuler : null}
      onUpdatePerspectiveRuler={documentStoreActions.setPerspectiveRuler}
      activeLockedAxis={activeLockedAxis}
      is3DLayerOpen={is3DLayerOpen}
      initial3DFile={initial3DFile}
      onClose3DLayer={handleClose3DLayer}
      onInsertRasterLayer={props.onInsertRasterLayer}
      isWebtoonMode={isWebtoonMode}
      onToggleWebtoonMode={handleToggleWebtoon}
      onOpenWebtoonExport={handleOpenWebtoonExport}
      activeBalloon={props.activeBalloon}
      onUpdateBalloon={handleUpdateBalloon}
      onConfirmBalloon={props.onConfirmBalloon}
      onDeleteBalloon={props.onDeleteBalloon}
      animationTimeline={props.animationTimeline}
      onUpdateAnimationTimeline={props.onUpdateAnimationTimeline}
      onAddAnimationCel={props.onAddAnimationCel}
      onDeleteAnimationCel={props.onDeleteAnimationCel}
      onSelectCelLayer={props.onSelectCelLayer}
      softProofSettings={softProofSettings}
    />
  );
});
CanvasAreaContainer.displayName = 'CanvasAreaContainer';

interface StatusBarContainerProps {
  zoom: number;
  rotation: number;
  onResetRotation: () => void;
}

/**
 * Isolated store-connected StatusBar wrapper so brush/tool changes only
 * re-render StatusBar without re-rendering AppShell, Header, or Layers.
 */
const StatusBarContainer: React.FC<StatusBarContainerProps> = React.memo(
  ({ zoom, rotation, onResetRotation }) => {
    const tool = useToolStore((s) => s.tool);
    const brushSettings = useToolStore((s) => s.brushSettings);
    const colorMode = useDocumentStore((s) => s.colorMode);
    const hasOpenDocument = useDocumentStore(selectHasOpenDocument);
    const softProofSettings = useDocumentStore((s) => s.softProofSettings);
    const showCursorCoordinates = useUiStore((s) => s.appSettings.showCursorCoordinates);
    const showPressureInStatusBar = useUiStore((s) => s.appSettings.showPressureInStatusBar);
    const themePreset = useUiStore((s) => s.appSettings.themePreset);

    return (
      <StatusBar
        tool={tool}
        brushSettings={brushSettings}
        zoom={zoom}
        rotation={rotation}
        onResetRotation={onResetRotation}
        colorMode={colorMode}
        showCursorCoordinates={showCursorCoordinates}
        showPressureInStatusBar={showPressureInStatusBar}
        hasOpenDocument={hasOpenDocument}
        themePreset={themePreset}
        softProofSettings={softProofSettings}
      />
    );
  }
);
StatusBarContainer.displayName = 'StatusBarContainer';

export interface AppShellProps {
  fileInputRef: React.RefObject<HTMLInputElement | null>;
  pasteFileInputRef: React.RefObject<HTMLInputElement | null>;
  import3DFileInputRef: React.RefObject<HTMLInputElement | null>;
  handleFileInputChange: (e: React.ChangeEvent<HTMLInputElement>) => void;
  handlePasteFileInputChange: (e: React.ChangeEvent<HTMLInputElement>) => void;
  handleImport3DFileInputChange: (e: React.ChangeEvent<HTMLInputElement>) => void;
  // Header props
  canUndo: boolean;
  canRedo: boolean;
  handleUndo: () => void;
  redo: () => void;
  zoom: number;
  zoomIn: () => void;
  zoomOut: () => void;
  resetZoomAndCenter: () => void;
  rotation: number;
  resetRotation: () => void;
  flipX: boolean;
  flipY: boolean;
  toggleFlipHorizontal: () => void;
  toggleFlipVertical: () => void;
  resetViewFlip: () => void;
  menuSections: MenuSection[];
  handleSelectDocument: (id: string) => void;
  handleCloseDocument: (id: string) => void;
  handleRenameDocument: (id: string, newName: string) => void;
  handleSave: () => void;
  handleSaveAs: () => void;
  handleClearActiveLayer: () => void;
  handleMergeDown: () => void;
  isCollabConnected: boolean;
  collabPeerCount: number;
  onOpenCollabModal: () => void;
  // Welcome props
  handleTriggerOpenFile: () => void;
  handleSelectWelcomeDocument: (doc: RecentDocument) => void;
  showToast: (msg: string) => void;
  // Canvas & Drawing props
  canvasProps: CanvasAreaContainerProps;
  // RightSidebar props
  historyList: HistoryItemMeta[];
  historyIndex: number;
  jumpToHistoryIndex: (index: number) => void;
  layers: LayerItem[];
  activeLayerId: string;
  selectedLayerIds: string[];
  setActiveLayerId: (id: string) => void;
  toggleLayerSelection: (id: string, isShift: boolean, isCtrl: boolean) => void;
  handleGroupSelectedLayers: () => void;
  handleDeleteSelectedLayers: () => void;
  handleAddLayer: (type?: 'raster' | 'folder') => void;
  duplicateLayer: (id: string) => void;
  handleDeleteLayer: (id: string) => void;
  handleToggleVisibility: (id: string) => void;
  handleSetOpacity: (id: string, opacity: number) => void;
  setBlendMode: (id: string, blendMode: BlendMode) => void;
  toggleLock: (id: string) => void;
  toggleAlphaLock: (id: string) => void;
  toggleClipping: (id: string) => void;
  toggleCollapse: (id: string) => void;
  handleRenameLayer: (id: string, name: string) => void;
  moveLayer: (id: string, direction: 'up' | 'down') => void;
  moveLayerToFolder: (id: string, targetFolderId: string | null) => void;
  reorderLayers: (draggedId: string, targetId: string, position: 'above' | 'below' | 'inside') => void;
  handleToggleReferenceLayer: (id: string) => void;
  toggleTone: (id: string) => void;
  setToneFrequency: (id: string, frequency: number) => void;
  setToneAngle: (id: string, angle: number) => void;
  setToneDotShape: (id: string, dotShape: 'circle' | 'euclidean') => void;
  setToneDensity: (id: string, density: number) => void;
  setToneDensityType: (id: string, densityType: 'specified' | 'image') => void;
  toggleLayerColor: (id: string) => void;
  setLayerColor: (id: string, color: string) => void;
  setLayerSubColor: (id: string, color: string) => void;
  setLayerExpressionColor: (id: string, mode: ExpressionColor) => void;
  setLayerMonoThreshold: (id: string, threshold: number) => void;
  setLayerMonoExpressMode: (id: string, expressBlack: boolean, expressWhite: boolean) => void;
  handleApplyExpressionColor: (id: string) => void;
  handleApplyLayerColor: (id: string) => void;
  addLayerMask: (layerId: string) => void;
  removeLayerMask: (layerId: string, apply?: boolean) => void;
  toggleLayerMask: (layerId: string) => void;
  toggleMaskLinked: (layerId: string) => void;
  handleOpenAdjustmentModal: (
    layerId?: string,
    initialType?: 'curves' | 'gradient-map' | 'levels' | 'color-balance'
  ) => void;
  handleOpenLayerStylesModal: (layerId?: string) => void;
  children?: React.ReactNode;
}

export const AppShell: React.FC<AppShellProps> = React.memo(
  ({
    fileInputRef,
    pasteFileInputRef,
    import3DFileInputRef,
    handleFileInputChange,
    handlePasteFileInputChange,
    handleImport3DFileInputChange,
    canUndo,
    canRedo,
    handleUndo,
    redo,
    zoom,
    zoomIn,
    zoomOut,
    resetZoomAndCenter,
    rotation,
    resetRotation,
    flipX,
    flipY,
    toggleFlipHorizontal,
    toggleFlipVertical,
    resetViewFlip,
    menuSections,
    handleSelectDocument,
    handleCloseDocument,
    handleRenameDocument,
    handleSave,
    handleSaveAs,
    handleClearActiveLayer,
    handleMergeDown,
    isCollabConnected,
    collabPeerCount,
    onOpenCollabModal,
    handleTriggerOpenFile,
    handleSelectWelcomeDocument,
    showToast,
    canvasProps,
    historyList,
    historyIndex,
    jumpToHistoryIndex,
    layers,
    activeLayerId,
    selectedLayerIds,
    setActiveLayerId,
    toggleLayerSelection,
    handleGroupSelectedLayers,
    handleDeleteSelectedLayers,
    handleAddLayer,
    duplicateLayer,
    handleDeleteLayer,
    handleToggleVisibility,
    handleSetOpacity,
    setBlendMode,
    toggleLock,
    toggleAlphaLock,
    toggleClipping,
    toggleCollapse,
    handleRenameLayer,
    moveLayer,
    moveLayerToFolder,
    reorderLayers,
    handleToggleReferenceLayer,
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
    handleApplyExpressionColor,
    handleApplyLayerColor,
    addLayerMask,
    removeLayerMask,
    toggleLayerMask,
    toggleMaskLinked,
    handleOpenAdjustmentModal,
    handleOpenLayerStylesModal,
    children,
  }) => {
    const dimensions = useDocumentStore((s) => s.dimensions);
    const colorMode = useDocumentStore((s) => s.colorMode);
    const documents = useDocumentStore((s) => s.documents);
    const activeDocumentId = useDocumentStore((s) => s.activeDocumentId);
    const hasOpenDocument = useDocumentStore(selectHasOpenDocument);
    const softProofSettings = useDocumentStore((s) => s.softProofSettings);
    const activeEditTarget = useDocumentStore((s) => s.activeEditTarget);

    const appView = useUiStore((s) => s.appView);
    const modernAccent = useUiStore((s) => s.appSettings.modernAccent || 'neutral');
    const modernCustomColor = useUiStore((s) => s.appSettings.modernCustomColor);
    const themePreset = useUiStore((s) => s.appSettings.themePreset);
    const userName = useUiStore((s) => s.appSettings.userName);
    const showStatusBar = useWorkspaceStore((s) => s.showStatusBar);
    const showDocumentTabs = useWorkspaceStore((s) => s.showDocumentTabs);

    useEffect(() => {
      const hex = resolveModernAccentColor(modernAccent, modernCustomColor);
      const rgb = hexToRgb(hex) || { r: 229, g: 229, b: 229 };
      const contrast = getAccentContrastColor(hex);

      const root = document.documentElement;
      root.setAttribute('data-theme', themePreset);
      root.setAttribute('data-accent', modernAccent);
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
    }, [modernAccent, modernCustomColor, themePreset]);

    const modernAccentHex = resolveModernAccentColor(modernAccent, modernCustomColor);
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
      [
        modernAccentHex,
        modernAccentRgb.r,
        modernAccentRgb.g,
        modernAccentRgb.b,
        modernAccentContrast,
      ]
    );

    const handleOpenNewCanvas = useCallback(() => {
      uiStoreActions.setNewCanvasModalOpen(true);
    }, []);

    const handleOpenSettings = useCallback(() => {
      uiStoreActions.setSettingsModalOpen(true);
    }, []);

    const handleOpen3DLayer = useCallback(() => {
      uiStoreActions.set3DLayerOpen(true);
    }, []);

    const handleSelectAppView = useCallback(
      (view: 'home' | 'workspace') => {
        if (view === 'workspace' && !hasOpenDocument) {
          uiStoreActions.setNewCanvasModalOpen(true);
        } else {
          uiStoreActions.setAppView(view);
        }
      },
      [hasOpenDocument]
    );

    const handleToggleTransparentColor = useCallback(() => {
      const next = toolStoreActions.toggleTransparentColor();
      showToast(next ? 'Transparent ink mode active' : 'Color ink mode active');
    }, [showToast]);

    const handleSwapColors = useCallback(() => {
      toolStoreActions.swapColors(colorMode);
    }, [colorMode]);

    const handleNewRasterLayer = useCallback(() => {
      handleAddLayer('raster');
    }, [handleAddLayer]);

    const handleDuplicateActiveLayer = useCallback(() => {
      if (activeLayerId) duplicateLayer(activeLayerId);
    }, [activeLayerId, duplicateLayer]);

    const commandHandlers = useMemo<WorkspaceCommandHandlers>(
      () => ({
        canUndo: hasOpenDocument && canUndo,
        canRedo: hasOpenDocument && canRedo,
        onUndo: handleUndo,
        onRedo: redo,
        onSave: handleSave,
        onSaveAs: handleSaveAs,
        onNewLayer: handleNewRasterLayer,
        onDuplicateLayer: handleDuplicateActiveLayer,
        onClearLayer: handleClearActiveLayer,
        onMergeDown: handleMergeDown,
        onFlipHorizontal: toggleFlipHorizontal,
        onFlipVertical: toggleFlipVertical,
        flipX,
        flipY,
        onResetZoom: resetZoomAndCenter,
        onResetRotation: resetRotation,
        onTransform: canvasProps.onTransformSelection,
        onDeselect: canvasProps.onDeselect,
        onSwapColors: handleSwapColors,
        onToggleTransparentColor: handleToggleTransparentColor,
        hasOpenDocument,
      }),
      [
        hasOpenDocument,
        canUndo,
        canRedo,
        handleUndo,
        redo,
        handleSave,
        handleSaveAs,
        handleNewRasterLayer,
        handleDuplicateActiveLayer,
        handleClearActiveLayer,
        handleMergeDown,
        toggleFlipHorizontal,
        toggleFlipVertical,
        flipX,
        flipY,
        resetZoomAndCenter,
        resetRotation,
        canvasProps.onTransformSelection,
        canvasProps.onDeselect,
        handleSwapColors,
        handleToggleTransparentColor,
      ]
    );

    const layerSidebarProps = useMemo(
      () => ({
        hasOpenDocument,
        onNewCanvas: handleOpenNewCanvas,
        onOpenFile: handleTriggerOpenFile,
        colorMode,
        historyList: hasOpenDocument ? historyList : [],
        historyIndex: hasOpenDocument ? historyIndex : -1,
        onJumpToHistory: jumpToHistoryIndex,
        canUndo: hasOpenDocument && canUndo,
        canRedo: hasOpenDocument && canRedo,
        onUndo: handleUndo,
        onRedo: redo,
        layers: hasOpenDocument ? layers : [],
        activeLayerId: hasOpenDocument ? activeLayerId : '',
        selectedLayerIds: hasOpenDocument ? selectedLayerIds : [],
        onSelectLayer: setActiveLayerId,
        onToggleLayerSelection: toggleLayerSelection,
        onGroupSelectedLayers: handleGroupSelectedLayers,
        onDeleteSelectedLayers: handleDeleteSelectedLayers,
        onAddLayer: handleAddLayer,
        onOpen3DLayer: hasOpenDocument ? handleOpen3DLayer : undefined,
        onDuplicateLayer: duplicateLayer,
        onDeleteLayer: handleDeleteLayer,
        onToggleVisibility: handleToggleVisibility,
        onSetOpacity: handleSetOpacity,
        onSetBlendMode: setBlendMode,
        onToggleLock: toggleLock,
        onToggleAlphaLock: toggleAlphaLock,
        onToggleClipping: toggleClipping,
        onToggleCollapse: toggleCollapse,
        onRenameLayer: handleRenameLayer,
        onMoveLayer: moveLayer,
        onMoveLayerToFolder: moveLayerToFolder,
        onReorderLayers: reorderLayers,
        onToggleReferenceLayer: handleToggleReferenceLayer,
        onToggleTone: toggleTone,
        onSetToneFrequency: setToneFrequency,
        onSetToneAngle: setToneAngle,
        onSetToneDotShape: setToneDotShape,
        onSetToneDensity: setToneDensity,
        onSetToneDensityType: setToneDensityType,
        onToggleLayerColor: toggleLayerColor,
        onSetLayerColor: setLayerColor,
        onSetLayerSubColor: setLayerSubColor,
        onSetLayerExpressionColor: setLayerExpressionColor,
        onSetLayerMonoThreshold: setLayerMonoThreshold,
        onSetLayerMonoExpressMode: setLayerMonoExpressMode,
        onApplyExpressionColor: handleApplyExpressionColor,
        onApplyLayerColor: handleApplyLayerColor,
        activeEditTarget,
        onSelectEditTarget: documentStoreActions.setActiveEditTarget,
        onAddLayerMask: addLayerMask,
        onRemoveLayerMask: removeLayerMask,
        onToggleLayerMask: toggleLayerMask,
        onToggleMaskLinked: toggleMaskLinked,
        onOpenAdjustmentModal: handleOpenAdjustmentModal,
        onOpenLayerStylesModal: handleOpenLayerStylesModal,
      }),
      [
        hasOpenDocument,
        handleOpenNewCanvas,
        handleTriggerOpenFile,
        colorMode,
        historyList,
        historyIndex,
        jumpToHistoryIndex,
        canUndo,
        canRedo,
        handleUndo,
        redo,
        layers,
        activeLayerId,
        selectedLayerIds,
        setActiveLayerId,
        toggleLayerSelection,
        handleGroupSelectedLayers,
        handleDeleteSelectedLayers,
        handleAddLayer,
        handleOpen3DLayer,
        duplicateLayer,
        handleDeleteLayer,
        handleToggleVisibility,
        handleSetOpacity,
        setBlendMode,
        toggleLock,
        toggleAlphaLock,
        toggleClipping,
        toggleCollapse,
        handleRenameLayer,
        moveLayer,
        moveLayerToFolder,
        reorderLayers,
        handleToggleReferenceLayer,
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
        handleApplyExpressionColor,
        handleApplyLayerColor,
        activeEditTarget,
        addLayerMask,
        removeLayerMask,
        toggleLayerMask,
        toggleMaskLinked,
        handleOpenAdjustmentModal,
        handleOpenLayerStylesModal,
      ]
    );

    return (
      <div
        className="flex flex-col w-screen h-screen overflow-hidden bg-[#161616] text-[#e5e5e5] font-sans gap-px app-root-container"
        data-theme={themePreset}
        data-accent={modernAccent}
        style={modernStyleVars}
      >
        {/* Hidden File Inputs */}
        <input
          ref={fileInputRef}
          type="file"
          accept=".png,.jpg,.jpeg,.webp,.bmp,.gif,.svg,.psd,.psb,.clip,.csp,.sora,.ink,.sut"
          onChange={handleFileInputChange}
          className="hidden"
        />
        <input
          ref={pasteFileInputRef}
          type="file"
          accept=".png,.jpg,.jpeg,.webp,.bmp,.gif,.svg,.ico,image/*"
          onChange={handlePasteFileInputChange}
          className="hidden"
        />
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
          flipX={flipX}
          flipY={flipY}
          onToggleFlipHorizontal={toggleFlipHorizontal}
          onToggleFlipVertical={toggleFlipVertical}
          onResetViewFlip={resetViewFlip}
          dimensions={dimensions}
          colorMode={colorMode}
          menuSections={menuSections}
          hasOpenDocument={hasOpenDocument}
          documents={documents}
          activeDocumentId={activeDocumentId}
          onSelectDocument={handleSelectDocument}
          onCloseDocument={handleCloseDocument}
          onNewDocument={handleOpenNewCanvas}
          onRenameDocument={handleRenameDocument}
          commandHandlers={commandHandlers}
          isCollabConnected={isCollabConnected}
          collabPeerCount={collabPeerCount}
          onOpenCollabModal={onOpenCollabModal}
          onOpenSettings={handleOpenSettings}
          themePreset={themePreset}
          softProofSettings={softProofSettings}
          appView={appView}
          onSelectAppView={handleSelectAppView}
        />

        {/* Main Workspace */}
        <div className="flex flex-1 min-h-0 overflow-hidden relative gap-px bg-[#161616]">
          {!hasOpenDocument || appView === 'home' ? (
            <WelcomeScreen
              userName={userName}
              onNewDocument={handleOpenNewCanvas}
              onOpenFile={handleTriggerOpenFile}
              onSelectRecentDocument={handleSelectWelcomeDocument}
              showToast={showToast}
              themePreset={themePreset}
            />
          ) : (
            <DockWorkspace
              themePreset={themePreset}
              colorMode={colorMode}
              commandHandlers={commandHandlers}
              onDeselect={canvasProps.onDeselect}
              onTransformSelection={canvasProps.onTransformSelection}
              onExpandSelection={canvasProps.onExpandSelection}
              onContractSelection={canvasProps.onContractSelection}
              onFeatherSelection={canvasProps.onFeatherSelection}
              onInvertSelection={canvasProps.onInvertSelection}
              onToggleTransparentColor={handleToggleTransparentColor}
              layerSidebarProps={layerSidebarProps}
            >
              {showDocumentTabs && (
                <DocumentTabBar
                  documents={documents}
                  activeDocumentId={activeDocumentId}
                  onSelectDocument={handleSelectDocument}
                  onCloseDocument={handleCloseDocument}
                  onNewDocument={handleOpenNewCanvas}
                  onRenameDocument={handleRenameDocument}
                  themePreset={themePreset}
                />
              )}

              <div className="flex flex-col flex-1 min-w-0 min-h-0 overflow-hidden relative">
                <CanvasAreaContainer {...canvasProps} />
              </div>

              {showStatusBar && (
                <StatusBarContainer
                  zoom={zoom}
                  rotation={rotation}
                  onResetRotation={resetRotation}
                />
              )}
            </DockWorkspace>
          )}
        </div>

        {children}
      </div>
    );
  }
);

AppShell.displayName = 'AppShell';
