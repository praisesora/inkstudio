import React, { useCallback } from 'react';
import { CheckCircle2, Loader2 } from 'lucide-react';
import {
  AdjustmentLayerData,
  FilterType,
  LayerItem,
  LayerStyles,
  NewCanvasOptions,
} from '../types/editor';
import { AppSettings, ResizeCanvasOptions } from '../types/settings';
import { CollabPeer, CollabRole, ConnectionStatus, SessionHostInfo } from '../types/multiplayer';
import { ParsedInviteLink } from '../services/multiplayerService';
import { CrashedSessionInfo } from '../services/recoveryService';
import { TonalCorrectionType } from '../utils/tonalEngine';
import { AnyFilterParams, AnyTonalParams } from '../hooks/useTonalAndFilterActions';
import { SaturatedLinesOptions, StreamLinesOptions } from '../utils/mangaEffectsEngine';
import { compositeCanvas, createDocumentRegionRenderer } from '../utils/saveManager';
import { documentStore } from '../utils/documentStore';
import { useDocumentStore, useUiStore, uiStoreActions } from '../stores';
import { CrashRecoveryModal } from './CrashRecoveryModal';
import { NewCanvasModal } from './NewCanvasModal';
import { ResizeCanvasModal } from './ResizeCanvasModal';
import { SettingsModal } from './SettingsModal';
import { AboutModal } from './AboutModal';
import { TonalCorrectionModal } from './TonalCorrectionModal';
import { AdjustmentModal } from './AdjustmentModal';
import { LayerStylesModal } from './LayerStylesModal';
import { SimpleToneModal, SimpleToneSettings } from './SimpleToneModal';
import { HostModal } from './HostModal';
import { ClipboardInviteToast } from './ClipboardInviteToast';
import { WebLandingModal } from './WebLandingModal';
import { MangaEffectsModal } from './MangaEffectsModal';
import { WebtoonExportModal } from './WebtoonExportModal';
import { TimelapseExportModal } from './TimelapseExportModal';
import { UpdateModal } from './UpdateModal';
import { UpdateToast } from './UpdateToast';
import { BrushStudioModal } from './BrushStudioModal';
import { CloseConfirmModal } from './CloseConfirmModal';
import { ConfirmDialogModal } from './ConfirmDialogModal';
import { FilterModal } from './FilterModal';
import { SaveDocumentResult } from '../utils/appCloseFlow';

export type InviteLinkPayload = ParsedInviteLink;

export interface ModalHostProps {
  layers: LayerItem[];
  activeLayer: LayerItem | undefined;
  getEffectiveOpacity: (layer: LayerItem) => number;
  isLayerEffectivelyVisible: (layer: LayerItem) => boolean;
  handleCreateNewCanvas: (options: NewCanvasOptions) => void;
  handleResizeCanvas: (options: ResizeCanvasOptions) => void;
  handleUpdateSettings: (newSettings: AppSettings) => void;
  handleRestoreCrashedSession: (session: CrashedSessionInfo) => Promise<void>;
  handleDiscardCrashedSession: (session: CrashedSessionInfo) => Promise<void>;
  handleTonalCancel: () => void;
  handleTonalApply: (type: TonalCorrectionType, params: AnyTonalParams) => void;
  handleTonalPreviewChange: (
    type: TonalCorrectionType,
    params: AnyTonalParams,
    enabled: boolean
  ) => void;
  handleApplyFilter: (type: FilterType, params?: AnyFilterParams) => void;
  handleApplyAdjustment: (
    type: 'curves' | 'gradient-map' | 'levels' | 'color-balance',
    data: AdjustmentLayerData
  ) => void;
  handleApplyLayerStyles: (styles: LayerStyles) => void;
  handleConfirmTone: (settings: SimpleToneSettings) => void;
  handleApplyMangaEffects: (
    type: 'saturated' | 'stream',
    options: SaturatedLinesOptions | StreamLinesOptions
  ) => void;
  // Multiplayer modal props
  isHostModalOpen: boolean;
  setIsHostModalOpen: (open: boolean) => void;
  isCollabHost: boolean;
  isCollabConnected: boolean;
  collabConnectionStatus?: ConnectionStatus;
  collabReconnectAttempt?: number;
  collabMyRole?: CollabRole;
  collabHostInfo: SessionHostInfo | null;
  collabPeers: CollabPeer[];
  collabBannedPeerIds?: string[];
  collabMyPeer: CollabPeer;
  updateMyName: (name: string) => void;
  handleStartHosting: (
    roomName: string,
    port: number,
    hostNickname?: string,
    isGlobal?: boolean,
    onStatus?: (status: string) => void
  ) => Promise<boolean | SessionHostInfo>;
  stopHosting: () => void;
  joinByInviteUrl: (rawUrl: string, nickname?: string, persistName?: boolean) => Promise<boolean>;
  leaveRoom: () => void;
  onSetPeerRole?: (peerId: string | number, role: 'editor' | 'viewer') => void;
  onKickPeer?: (peerId: string | number) => void;
  onBanPeer?: (peerId: string | number) => void;
  onUnbanPeer?: (peerId: string | number) => void;
  clipboardInvite: InviteLinkPayload | null;
  setClipboardInvite: (invite: InviteLinkPayload | null) => void;
  webLandingInvite: InviteLinkPayload | null;
  setWebLandingInvite: (invite: InviteLinkPayload | null) => void;
  joinRoom: (
    host: string,
    port: number,
    roomName: string,
    name?: string,
    token?: string,
    isSecureOverride?: boolean,
    persistName?: boolean
  ) => Promise<boolean>;
  onCaptureTimelapseNow?: () => void;
  handleSave?: () => void;
  handleSaveDocumentById: (docId: string) => Promise<SaveDocumentResult>;
  showToast: (msg: string) => void;
}

export const ModalHost: React.FC<ModalHostProps> = React.memo(
  ({
    layers,
    activeLayer,
    getEffectiveOpacity,
    isLayerEffectivelyVisible,
    handleCreateNewCanvas,
    handleResizeCanvas,
    handleUpdateSettings,
    handleRestoreCrashedSession,
    handleDiscardCrashedSession,
    handleTonalCancel,
    handleTonalApply,
    handleTonalPreviewChange,
    handleApplyFilter,
    handleApplyAdjustment,
    handleApplyLayerStyles,
    handleConfirmTone,
    handleApplyMangaEffects,
    isHostModalOpen,
    setIsHostModalOpen,
    isCollabHost,
    isCollabConnected,
    collabConnectionStatus,
    collabReconnectAttempt,
    collabMyRole,
    collabHostInfo,
    collabPeers,
    collabBannedPeerIds,
    collabMyPeer,
    updateMyName,
    handleStartHosting,
    stopHosting,
    joinByInviteUrl,
    leaveRoom,
    onSetPeerRole,
    onKickPeer,
    onBanPeer,
    onUnbanPeer,
    clipboardInvite,
    setClipboardInvite,
    webLandingInvite,
    setWebLandingInvite,
    joinRoom,
    onCaptureTimelapseNow,
    handleSave,
    handleSaveDocumentById,
    showToast,
  }) => {
    const dimensions = useDocumentStore((s) => s.dimensions);
    const documents = useDocumentStore((s) => s.documents);
    const activeDocumentId = useDocumentStore((s) => s.activeDocumentId);

    const isRecoveryModalOpen = useUiStore((s) => s.isRecoveryModalOpen);
    const crashedSessions = useUiStore((s) => s.crashedSessions);
    const isNewCanvasModalOpen = useUiStore((s) => s.isNewCanvasModalOpen);
    const isResizeCanvasModalOpen = useUiStore((s) => s.isResizeCanvasModalOpen);
    const isSettingsModalOpen = useUiStore((s) => s.isSettingsModalOpen);
    const isAboutModalOpen = useUiStore((s) => s.isAboutModalOpen);
    const appSettings = useUiStore((s) => s.appSettings);
    const tonalModalState = useUiStore((s) => s.tonalModalState);
    const filterModalState = useUiStore((s) => s.filterModalState);
    const adjustmentModalState = useUiStore((s) => s.adjustmentModalState);
    const layerStylesModalState = useUiStore((s) => s.layerStylesModalState);
    const isToneModalOpen = useUiStore((s) => s.isToneModalOpen);
    const isMangaEffectsModalOpen = useUiStore((s) => s.isMangaEffectsModalOpen);
    const isWebtoonExportModalOpen = useUiStore((s) => s.isWebtoonExportModalOpen);
    const isTimelapseExportModalOpen = useUiStore((s) => s.isTimelapseExportModalOpen);
    const isBrushStudioModalOpen = useUiStore((s) => s.isBrushStudioModalOpen);
    const isLoadingFile = useUiStore((s) => s.isLoadingFile);
    const loadingStatus = useUiStore((s) => s.loadingStatus);
    const toastMessage = useUiStore((s) => s.toastMessage);

    const colorMode = useDocumentStore((s) => s.colorMode);

    const getWebtoonActiveCanvas = useCallback(
      () =>
        compositeCanvas(
          dimensions,
          layers,
          undefined,
          getEffectiveOpacity,
          isLayerEffectivelyVisible,
          false,
          documentStore.getActiveTileGrid(),
          { colorMode }
        ),
      [dimensions, layers, getEffectiveOpacity, isLayerEffectivelyVisible, colorMode]
    );

    const createWebtoonRegionRenderer = useCallback(
      () =>
        createDocumentRegionRenderer(
          dimensions,
          layers,
          undefined,
          getEffectiveOpacity,
          isLayerEffectivelyVisible,
          documentStore.getActiveTileGrid(),
          { colorMode }
        ),
      [dimensions, layers, getEffectiveOpacity, isLayerEffectivelyVisible, colorMode]
    );

    const activeDoc = documents.find((d) => d.id === activeDocumentId);

    return (
      <>
        <CrashRecoveryModal
          isOpen={isRecoveryModalOpen}
          sessions={crashedSessions}
          onRestore={handleRestoreCrashedSession}
          onDiscard={handleDiscardCrashedSession}
          onClose={() => uiStoreActions.setRecoveryModal(false)}
        />

        <NewCanvasModal
          isOpen={isNewCanvasModalOpen}
          onClose={() => uiStoreActions.setNewCanvasModalOpen(false)}
          onCreate={handleCreateNewCanvas}
          initialWidth={activeDoc ? dimensions.width : (appSettings.defaultWidth || 1920)}
          initialHeight={activeDoc ? dimensions.height : (appSettings.defaultHeight || 1080)}
          initialDpi={activeDoc ? (dimensions.dpi || 300) : (appSettings.defaultDpi || 300)}
          initialColorMode={activeDoc ? colorMode : (appSettings.defaultColorMode || 'color')}
          initialName="Untitled*"
        />

        <ResizeCanvasModal
          isOpen={isResizeCanvasModalOpen}
          onClose={() => uiStoreActions.setResizeCanvasModalOpen(false)}
          currentDimensions={dimensions}
          onResize={handleResizeCanvas}
        />

        <SettingsModal
          isOpen={isSettingsModalOpen}
          onClose={() => uiStoreActions.setSettingsModalOpen(false)}
          settings={appSettings}
          onUpdateSettings={handleUpdateSettings}
          onShowToast={showToast}
        />

        <AboutModal
          isOpen={isAboutModalOpen}
          onClose={() => uiStoreActions.setAboutModalOpen(false)}
          showToast={showToast}
        />

        <BrushStudioModal
          isOpen={isBrushStudioModalOpen}
          onClose={() => uiStoreActions.setBrushStudioModalOpen(false)}
          showToast={showToast}
        />

        <TonalCorrectionModal
          isOpen={tonalModalState.isOpen}
          type={tonalModalState.type}
          histograms={tonalModalState.histograms}
          selectionMask={tonalModalState.selectionMask}
          onClose={handleTonalCancel}
          onApply={handleTonalApply}
          onPreviewChange={handleTonalPreviewChange}
        />

        <FilterModal
          isOpen={filterModalState.isOpen}
          type={filterModalState.type}
          onClose={() => uiStoreActions.closeFilterModal()}
          onApply={handleApplyFilter}
        />

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
            onClose={() => uiStoreActions.setAdjustmentModalState({ isOpen: false })}
          />
        )}

        {layerStylesModalState.isOpen && (
          <LayerStylesModal
            isOpen={layerStylesModalState.isOpen}
            layerName={
              layers.find((l) => l.id === layerStylesModalState.layerId)?.name || 'Layer'
            }
            initialStyles={layers.find((l) => l.id === layerStylesModalState.layerId)?.styles}
            onClose={() => uiStoreActions.setLayerStylesModalState({ isOpen: false })}
            onApply={handleApplyLayerStyles}
          />
        )}

        <SimpleToneModal
          isOpen={isToneModalOpen}
          onClose={() => uiStoreActions.setToneModalOpen(false)}
          onConfirm={handleConfirmTone}
          initialFrequency={activeLayer?.toneFrequency || activeDoc?.defaultFrequency || 60}
          initialDensity={activeLayer?.toneDensity || 40}
          dpi={dimensions.dpi ?? 600}
        />

        <HostModal
          isOpen={isHostModalOpen}
          onClose={() => setIsHostModalOpen(false)}
          isHost={isCollabHost}
          isConnected={isCollabConnected}
          connectionStatus={collabConnectionStatus}
          reconnectAttempt={collabReconnectAttempt}
          myRole={collabMyRole}
          hostInfo={collabHostInfo}
          peers={collabPeers}
          bannedPeerIds={collabBannedPeerIds}
          myPeer={collabMyPeer}
          onUpdateMyName={updateMyName}
          onStartHosting={handleStartHosting}
          onStopHosting={stopHosting}
          onJoinByInviteUrl={joinByInviteUrl}
          onLeaveRoom={leaveRoom}
          onSetPeerRole={onSetPeerRole}
          onKickPeer={onKickPeer}
          onBanPeer={onBanPeer}
          onUnbanPeer={onUnbanPeer}
          showToast={showToast}
        />

        <ClipboardInviteToast
          invite={clipboardInvite}
          onJoin={(h, p, r, t, isSecure) =>
            void joinRoom(h, p, r, collabMyPeer.name, t, isSecure, false)
          }
          onDismiss={() => setClipboardInvite(null)}
        />

        <WebLandingModal
          invite={webLandingInvite}
          onJoinInBrowser={(name, h, p, r, t, isSecure, persistName) => {
            if (persistName) {
              updateMyName(name);
            }
            void joinRoom(h, p, r, name, t, isSecure, Boolean(persistName));
          }}
          onDismiss={() => setWebLandingInvite(null)}
        />

        {isLoadingFile && (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 select-none">
            <div className="bg-[#202020] border border-[#2c2c2c] rounded-lg shadow-[0_16px_48px_rgba(0,0,0,0.75)] px-5 py-3.5 flex items-center gap-3 text-xs text-[#e5e5e5]">
              <Loader2 className="w-4 h-4 text-[var(--accent)] animate-spin" />
              <div className="flex flex-col">
                <span className="font-medium text-xs">
                  {loadingStatus || 'Opening Document...'}
                </span>
                <span className="text-[#8a8a8a] text-[10px]">
                  {loadingStatus && /sav|export|composit|encod/i.test(loadingStatus)
                    ? 'Processing layers and tile data'
                    : 'Extracting layers and pixel data'}
                </span>
              </div>
            </div>
          </div>
        )}

        {toastMessage && (
          <div className="fixed bottom-5 right-5 z-50 bg-[#202020] border border-[#2c2c2c] text-[#e5e5e5] px-3.5 py-2 rounded-lg shadow-[0_12px_32px_rgba(0,0,0,0.65)] flex items-center gap-2 text-xs">
            <CheckCircle2 className="w-3.5 h-3.5 text-[var(--accent)]" />
            <span className="font-medium">{toastMessage}</span>
          </div>
        )}

        <MangaEffectsModal
          isOpen={isMangaEffectsModalOpen}
          onClose={() => uiStoreActions.setMangaEffectsModalOpen(false)}
          canvasWidth={dimensions.width}
          canvasHeight={dimensions.height}
          onApply={handleApplyMangaEffects}
        />

        <WebtoonExportModal
          isOpen={isWebtoonExportModalOpen}
          onClose={() => uiStoreActions.setWebtoonExportModalOpen(false)}
          getActiveCanvas={getWebtoonActiveCanvas}
          createRegionRenderer={createWebtoonRegionRenderer}
          canvasWidth={dimensions.width}
          canvasHeight={dimensions.height}
          documentTitle={activeDoc?.name || 'webtoon_chapter'}
        />

        <TimelapseExportModal
          isOpen={isTimelapseExportModalOpen}
          onClose={() => uiStoreActions.setTimelapseExportModalOpen(false)}
          documentId={activeDocumentId}
          documentName={activeDoc?.name || 'artwork'}
          onCaptureNow={onCaptureTimelapseNow}
          showToast={showToast}
        />

        <UpdateModal
          hasActiveCollabSession={Boolean(isCollabHost || collabHostInfo)}
          onSaveFirst={handleSave}
        />

        <UpdateToast />

        <CloseConfirmModal onSaveDocumentById={handleSaveDocumentById} />

        <ConfirmDialogModal />
      </>
    );
  }
);

ModalHost.displayName = 'ModalHost';
