import { useState, useEffect, useCallback, useRef } from 'react';
import { safeLocalStorageSetItem } from '../utils/safeStorage';
import {
  AccessDeniedMessage,
  CollabPeer,
  CollabRole,
  ConnectionStatus,
  SessionHostInfo,
  MultiplayerMessage,
  StrokeStartMessage,
  StrokeChunkMessage,
  StrokeFinishMessage,
  BrushAssetDataMessage,
  BrushAssetRequestMessage,
  CursorMoveMessage,
  JoinAcceptedMessage,
  LayerMaskDataMessage,
  PeerBanMessage,
  PeerKickMessage,
  PeerRoleUpdateMessage,
  PeerUnbanMessage,
  TileStreamMessage,
  SelectiveUndoMessage,
  WireLayerItem,
} from '../types/multiplayer';
import {
  buildP2pShareUrl,
  multiplayerService,
  parseCollabTarget,
  ParsedCollabTarget,
} from '../services/multiplayerService';
import { WebRtcHostHub, WebRtcTurnConfig } from '../services/webrtcHostHub';
import { WebRtcGuestClient } from '../services/webrtcGuestClient';
import {
  computeRoomTopicHash,
  generateP2pRoomCredentials,
  normalizeRoomCode,
  normalizeRoomSecret,
} from '../services/webrtcSignaling';
import {
  getBrushAssetRecord,
  registerRemoteBrushAsset,
} from '../utils/brushAssetSync';
import { serializeLayerForWire } from '../utils/collabSyncUtils';
import {
  normalizeRole,
  peerIdEquals,
  validateIncomingRemoteMutation,
} from '../utils/collabPermissions';
import {
  AnimationTimeline,
  CanvasColorMode,
  CanvasDimensions,
  LayerItem,
} from '../types/editor';
import { PerspectiveRuler, StraightRuler } from '../types/perspective';
import { ResizeCanvasOptions } from '../types/settings';
import { TileBuffer } from '../utils/tileEngine';
import { documentStore } from '../utils/documentStore';
import { uiStoreActions, useUiStore } from '../stores';
import {
  NICKNAME_CUSTOMIZED_STORAGE_KEY as NICKNAME_CUSTOMIZED_KEY,
  NICKNAME_STORAGE_KEY as NICKNAME_KEY,
} from '../types/settings';

const PEER_COLORS = [
  '#f43f5e', // Rose
  '#3b82f6', // Blue
  '#10b981', // Emerald
  '#f59e0b', // Amber
  '#8b5cf6', // Violet
  '#06b6d4', // Cyan
  '#ec4899', // Pink
  '#84cc16', // Lime
];

export const RECONNECT_BASE_DELAY_MS = 1000;
export const RECONNECT_MAX_DELAY_MS = 30000;
export const RECONNECT_MAX_ATTEMPTS = 12;

export function computeReconnectDelayMs(
  attempt: number,
  rng: () => number = Math.random
): number {
  const safeAttempt = Math.max(1, Math.floor(attempt));
  const exp = Math.min(
    RECONNECT_MAX_DELAY_MS,
    RECONNECT_BASE_DELAY_MS * Math.pow(2, safeAttempt - 1)
  );
  const raw = rng();
  const clampedRng = Math.max(0, Math.min(1, Number.isFinite(raw) ? raw : 0.5));
  const jitterFactor = 0.8 + 0.4 * clampedRng; // +/- 20% jitter
  return Math.min(RECONNECT_MAX_DELAY_MS, Math.round(exp * jitterFactor));
}

function getRandomColor(): string {
  return PEER_COLORS[Math.floor(Math.random() * PEER_COLORS.length)];
}

export function isTauriEnvironment(): boolean {
  if (typeof window === 'undefined') return false;
  return Boolean(
    (window as any).__TAURI_INTERNALS__ || (window as any).__TAURI__ || (window as any).isTauri
  );
}

function getInitialPeerName(): string {
  if (typeof window === 'undefined') return 'Guest';
  try {
    const isCustomized = localStorage.getItem(NICKNAME_CUSTOMIZED_KEY) === '1';
    const saved = (localStorage.getItem(NICKNAME_KEY) || '').trim();
    if (isCustomized && saved) {
      return saved;
    }
    if (!isTauriEnvironment()) {
      return 'Guest';
    }
    return 'Artist';
  } catch {
    return isTauriEnvironment() ? 'Artist' : 'Guest';
  }
}

type ActiveSessionParams =
  | {
      kind: 'ws';
      wsUrl: string;
      token?: string;
      roomName: string;
      host: string;
      port: number;
      isSecure: boolean;
      isHost: boolean;
    }
  | {
      kind: 'webrtc-guest';
      roomCode: string;
      roomSecret: string;
      roomHash: string;
      roomName: string;
      customSignalingUrl?: string;
      isHost: false;
    };

function getWebRtcNetworkConfigFromSettings(signalingOverride?: string): {
  customSignalingUrl?: string;
  turnConfig?: WebRtcTurnConfig;
} {
  const settings = useUiStore.getState().appSettings;
  const customSignalingUrl = (signalingOverride || settings.collabSignalingUrl || '').trim() || undefined;
  const turnUrl = (settings.collabTurnUrl || '').trim();
  const turnConfig: WebRtcTurnConfig | undefined = turnUrl
    ? {
        turnUrl,
        turnUsername: settings.collabTurnUsername || undefined,
        turnCredential: settings.collabTurnCredential || undefined,
      }
    : undefined;
  return { customSignalingUrl, turnConfig };
}

export interface UseMultiplayerProps {
  dimensions: CanvasDimensions;
  colorMode: CanvasColorMode;
  layers: LayerItem[];
  perspectiveRuler?: PerspectiveRuler | null;
  straightRuler?: StraightRuler | null;
  animationTimeline?: AnimationTimeline | null;
  onRemoteStrokeStart?: (msg: StrokeStartMessage) => void;
  onRemoteStrokeChunk?: (msg: StrokeChunkMessage) => void;
  onRemoteStrokeFinish?: (msg: StrokeFinishMessage) => void;
  onRemoteLayerAction?: (msg: MultiplayerMessage) => void;
  onRemoteMaskData?: (msg: LayerMaskDataMessage) => void;
  onRemotePerspectiveRuler?: (ruler: PerspectiveRuler | null) => void;
  onRemoteStraightRuler?: (ruler: StraightRuler | null) => void;
  onRemoteAnimationSync?: (timeline: AnimationTimeline | null) => void;
  onRemoteCanvasResize?: (dimensions: CanvasDimensions, options: ResizeCanvasOptions) => void;
  onRemoteDocSync?: (
    dimensions: CanvasDimensions,
    colorMode: CanvasColorMode,
    layers: WireLayerItem[],
    assignedLayerId?: string,
    roomName?: string,
    perspectiveRuler?: PerspectiveRuler | null,
    straightRuler?: StraightRuler | null,
    animationTimeline?: AnimationTimeline | null,
    isReconnect?: boolean
  ) => void;
  onRemoteJoinRequest?: (
    peer: CollabPeer
  ) => { assignedLayerId: string; updatedLayers: LayerItem[] } | void;
  onRemoteAssignedLayer?: (layerId: string) => void;
  onRemoteSelectiveUndo?: (strokeId: string, peerId: string | number) => void;
  onRemoteTileApplied?: (layerId: string) => void;
  onRemotePeerLeft?: (peerId: string | number) => void;
  showToast: (msg: string) => void;
}

export function useMultiplayer({
  dimensions,
  colorMode,
  layers,
  perspectiveRuler = null,
  straightRuler = null,
  animationTimeline = null,
  onRemoteStrokeStart,
  onRemoteStrokeChunk,
  onRemoteStrokeFinish,
  onRemoteLayerAction,
  onRemoteMaskData,
  onRemotePerspectiveRuler,
  onRemoteStraightRuler,
  onRemoteAnimationSync,
  onRemoteCanvasResize,
  onRemoteDocSync,
  onRemoteJoinRequest,
  onRemoteAssignedLayer,
  onRemoteSelectiveUndo,
  onRemoteTileApplied,
  onRemotePeerLeft,
  showToast,
}: UseMultiplayerProps) {
  const [connectionStatus, setConnectionStatus] = useState<ConnectionStatus>('disconnected');
  const [isConnected, setIsConnected] = useState(false);
  const [reconnectAttempt, setReconnectAttempt] = useState(0);
  const [isHost, setIsHost] = useState(false);
  const [myRole, setMyRole] = useState<CollabRole>('editor');
  const [hostInfo, setHostInfo] = useState<SessionHostInfo | null>(null);
  const [peers, setPeers] = useState<CollabPeer[]>([]);
  const [bannedPeerIds, setBannedPeerIds] = useState<string[]>([]);

  const peersRef = useRef<CollabPeer[]>([]);
  const myRoleRef = useRef<CollabRole>('editor');
  const bannedPeerIdsRef = useRef<Set<string>>(new Set());
  const peerRolesRef = useRef<Map<string, CollabRole>>(new Map());

  const [myPeer, setMyPeer] = useState<CollabPeer>(() => ({
    id: `peer-${Date.now()}-${Math.random().toString(36).substring(2, 6)}`,
    name: getInitialPeerName(),
    color: getRandomColor(),
    role: 'editor',
  }));
  const myPeerRef = useRef(myPeer);

  const [activePings, setActivePings] = useState<
    Array<{ id: string; x: number; y: number; color: string; name: string }>
  >([]);
  const [isHostModalOpen, setIsHostModalOpen] = useState(false);

  // Smart Clipboard Invitation Prompt (supports WS links, P2P links, and INK-XXXX room codes)
  const [clipboardInvite, setClipboardInvite] = useState<ParsedCollabTarget | null>(null);
  const lastProcessedClipboardUrlRef = useRef<string | null>(null);

  // Web Landing modal for browser guests visiting via ?room=... or ?p2p=...
  const [webLandingInvite, setWebLandingInvite] = useState<ParsedCollabTarget | null>(null);

  // Auto-reconnect & seq/version tracking refs
  const sessionParamsRef = useRef<ActiveSessionParams | null>(null);
  const intentionalDisconnectRef = useRef(false);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const reconnectAttemptRef = useRef(0);
  const isReconnectingInFlightRef = useRef(false);
  const pendingReconnectCatchUpRef = useRef(false);
  const lastAppliedSeqRef = useRef(0);
  const tileSeqMapRef = useRef<Map<string, number>>(new Map());
  const tileVersionMapRef = useRef<Map<string, number>>(new Map());
  const docFieldSeqRef = useRef({
    layerTree: 0,
    perspectiveRuler: 0,
    straightRuler: 0,
    animationTimeline: 0,
    canvasResize: 0,
  });

  // Synchronous refs for event handlers
  const dimensionsRef = useRef(dimensions);
  const colorModeRef = useRef(colorMode);
  const layersRef = useRef(layers);
  const perspectiveRulerRef = useRef(perspectiveRuler);
  const straightRulerRef = useRef(straightRuler);
  const animationTimelineRef = useRef(animationTimeline);
  const isHostRef = useRef(isHost);
  const hostInfoRef = useRef(hostInfo);

  dimensionsRef.current = dimensions;
  colorModeRef.current = colorMode;
  layersRef.current = layers;
  perspectiveRulerRef.current = perspectiveRuler;
  straightRulerRef.current = straightRuler;
  animationTimelineRef.current = animationTimeline;
  isHostRef.current = isHost;
  hostInfoRef.current = hostInfo;
  myPeerRef.current = myPeer;
  peersRef.current = peers;
  myRoleRef.current = myRole;

  // Keep callback refs
  const onRemoteStrokeStartRef = useRef(onRemoteStrokeStart);
  const onRemoteStrokeChunkRef = useRef(onRemoteStrokeChunk);
  const onRemoteStrokeFinishRef = useRef(onRemoteStrokeFinish);
  const onRemoteLayerActionRef = useRef(onRemoteLayerAction);
  const onRemoteMaskDataRef = useRef(onRemoteMaskData);
  const onRemotePerspectiveRulerRef = useRef(onRemotePerspectiveRuler);
  const onRemoteStraightRulerRef = useRef(onRemoteStraightRuler);
  const onRemoteAnimationSyncRef = useRef(onRemoteAnimationSync);
  const onRemoteCanvasResizeRef = useRef(onRemoteCanvasResize);
  const onRemoteDocSyncRef = useRef(onRemoteDocSync);
  const onRemoteJoinRequestRef = useRef(onRemoteJoinRequest);
  const onRemoteAssignedLayerRef = useRef(onRemoteAssignedLayer);
  const onRemoteSelectiveUndoRef = useRef(onRemoteSelectiveUndo);
  const onRemoteTileAppliedRef = useRef(onRemoteTileApplied);
  const onRemotePeerLeftRef = useRef(onRemotePeerLeft);
  const showToastRef = useRef(showToast);

  onRemoteStrokeStartRef.current = onRemoteStrokeStart;
  onRemoteStrokeChunkRef.current = onRemoteStrokeChunk;
  onRemoteStrokeFinishRef.current = onRemoteStrokeFinish;
  onRemoteLayerActionRef.current = onRemoteLayerAction;
  onRemoteMaskDataRef.current = onRemoteMaskData;
  onRemotePerspectiveRulerRef.current = onRemotePerspectiveRuler;
  onRemoteStraightRulerRef.current = onRemoteStraightRuler;
  onRemoteAnimationSyncRef.current = onRemoteAnimationSync;
  onRemoteCanvasResizeRef.current = onRemoteCanvasResize;
  onRemoteDocSyncRef.current = onRemoteDocSync;
  onRemoteJoinRequestRef.current = onRemoteJoinRequest;
  onRemoteAssignedLayerRef.current = onRemoteAssignedLayer;
  onRemoteSelectiveUndoRef.current = onRemoteSelectiveUndo;
  onRemoteTileAppliedRef.current = onRemoteTileApplied;
  onRemotePeerLeftRef.current = onRemotePeerLeft;
  showToastRef.current = showToast;

  const clearReconnectTimer = useCallback(() => {
    if (reconnectTimerRef.current !== null) {
      clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = null;
    }
  }, []);

  const applyLocalRole = useCallback((nextRole: CollabRole) => {
    myRoleRef.current = nextRole;
    setMyRole(nextRole);
    multiplayerService.setLocalRole(nextRole);
    setMyPeer((prev) => {
      if (prev.role === nextRole && Boolean(prev.isHost) === (nextRole === 'host')) {
        return prev;
      }
      const next: CollabPeer = {
        ...prev,
        role: nextRole,
        isHost: nextRole === 'host',
      };
      myPeerRef.current = next;
      return next;
    });
  }, []);

  const resetSessionState = useCallback(() => {
    clearReconnectTimer();
    isReconnectingInFlightRef.current = false;
    pendingReconnectCatchUpRef.current = false;
    reconnectAttemptRef.current = 0;
    setReconnectAttempt(0);
    sessionParamsRef.current = null;
    setIsConnected(false);
    setConnectionStatus('disconnected');
    setIsHost(false);
    isHostRef.current = false;
    setHostInfo(null);
    hostInfoRef.current = null;
    setPeers([]);
    peersRef.current = [];
    bannedPeerIdsRef.current.clear();
    setBannedPeerIds([]);
    peerRolesRef.current.clear();
    lastAppliedSeqRef.current = 0;
    tileSeqMapRef.current.clear();
    tileVersionMapRef.current.clear();
    docFieldSeqRef.current = {
      layerTree: 0,
      perspectiveRuler: 0,
      straightRuler: 0,
      animationTimeline: 0,
      canvasResize: 0,
    };
    applyLocalRole('editor');
  }, [applyLocalRole, clearReconnectTimer]);

  // Desktop: resolve default peer name from OS account name unless explicitly customized
  useEffect(() => {
    if (!isTauriEnvironment()) return;
    try {
      if (
        localStorage.getItem(NICKNAME_CUSTOMIZED_KEY) === '1' &&
        (localStorage.getItem(NICKNAME_KEY) || '').trim()
      ) {
        return;
      }
    } catch {
      // ignore storage errors
    }

    let cancelled = false;
    (async () => {
      try {
        const { invoke } = await import('@tauri-apps/api/core');
        const osName = await invoke<string>('get_os_username');
        const trimmed = (osName || '').trim();
        if (!cancelled && trimmed) {
          setMyPeer((prev) => {
            const next = { ...prev, name: trimmed };
            myPeerRef.current = next;
            return next;
          });
          const curSettings = useUiStore.getState().appSettings;
          if (!curSettings.userName || curSettings.userName === 'Artist') {
            uiStoreActions.updateAppSettings({ ...curSettings, userName: trimmed });
          }
        }
      } catch {
        // Fallback stays 'Artist'
      }
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  // Keep myPeer.name synchronized when changed via SettingsModal
  useEffect(() => {
    return useUiStore.subscribe(() => {
      const configured = (useUiStore.getState().appSettings.userName || '').trim();
      if (configured && configured !== myPeerRef.current.name) {
        setMyPeer((prev) => {
          if (prev.name === configured) return prev;
          const next = { ...prev, name: configured };
          myPeerRef.current = next;
          return next;
        });
      }
    });
  }, []);

  // Paced async tile streaming so large canvases never saturate WS or server mpsc buffers
  const streamTilesPaced = useCallback(
    (layersToStream: LayerItem[], targetPeerId?: string | number) => {
      const activeGrid = documentStore.getActiveTileGrid();
      const queue: Array<{ layerId: string; tile: TileBuffer }> = [];
      for (const layer of layersToStream) {
        const tiles = activeGrid.getLayerTiles(layer.id);
        for (const tile of tiles) {
          if (tile.data && tile.data.byteLength > 0) {
            queue.push({ layerId: layer.id, tile });
          }
        }
      }
      if (queue.length === 0) return;

      let idx = 0;
      const BATCH_SIZE = 16;
      const MAX_BUFFERED_BYTES = 2 * 1024 * 1024;

      const pump = () => {
        if (!multiplayerService.isConnected()) return;
        if (multiplayerService.getBufferedAmount() > MAX_BUFFERED_BYTES) {
          setTimeout(pump, 20);
          return;
        }
        const end = Math.min(idx + BATCH_SIZE, queue.length);
        for (; idx < end; idx++) {
          const entry = queue[idx];
          multiplayerService.sendTileDelta(entry.layerId, entry.tile, targetPeerId);
        }
        if (idx < queue.length) {
          setTimeout(pump, 4);
        }
      };

      pump();
    },
    []
  );

  // Auto-reconnect scheduler with exponential backoff and missed seq/tile catch-up
  const scheduleReconnectRef = useRef<(immediate?: boolean) => void>(() => {});
  const scheduleReconnect = useCallback(
    (immediate = false) => {
      if (intentionalDisconnectRef.current) return;
      const params = sessionParamsRef.current;
      if (!params) return;
      if (multiplayerService.isConnected() || isReconnectingInFlightRef.current) return;

      clearReconnectTimer();

      const nextAttempt = reconnectAttemptRef.current + 1;
      if (nextAttempt > RECONNECT_MAX_ATTEMPTS) {
        const wasWebRtcGuest = params.kind === 'webrtc-guest';
        resetSessionState();
        showToastRef.current(
          wasWebRtcGuest
            ? 'Host disconnected — the P2P room has ended. Your canvas remains open locally.'
            : 'Unable to reconnect to collaborative session'
        );
        return;
      }

      reconnectAttemptRef.current = nextAttempt;
      setReconnectAttempt(nextAttempt);
      setConnectionStatus('reconnecting');
      setIsConnected(false);

      const delay = immediate ? 150 : computeReconnectDelayMs(nextAttempt);

      reconnectTimerRef.current = setTimeout(() => {
        reconnectTimerRef.current = null;
        if (intentionalDisconnectRef.current || !sessionParamsRef.current) return;
        if (multiplayerService.isConnected() || isReconnectingInFlightRef.current) return;

        const targetParams = sessionParamsRef.current;
        const sinceSeq = Math.max(
          lastAppliedSeqRef.current,
          multiplayerService.getLastServerSeq()
        );
        const reconnectPeer: CollabPeer = {
          ...myPeerRef.current,
          isHost: targetParams.isHost,
          role: myRoleRef.current,
        };

        isReconnectingInFlightRef.current = true;
        pendingReconnectCatchUpRef.current = true;

        const attemptConnect =
          targetParams.kind === 'ws'
            ? multiplayerService.connect(targetParams.wsUrl, reconnectPeer, targetParams.token, {
                isReconnect: true,
                sinceSeq,
              })
            : (async () => {
                const { customSignalingUrl, turnConfig } = getWebRtcNetworkConfigFromSettings(
                  targetParams.customSignalingUrl
                );
                const guestClient = new WebRtcGuestClient({
                  roomHash: targetParams.roomHash,
                  peerId: String(reconnectPeer.id),
                  customSignalingUrl,
                  turnConfig,
                });
                await guestClient.connect();
                multiplayerService.attachTransport(guestClient, reconnectPeer, {
                  isReconnect: true,
                  sinceSeq,
                  sendJoinRequest: true,
                });
              })();

        attemptConnect
          .then(() => {
            isReconnectingInFlightRef.current = false;
            if (intentionalDisconnectRef.current || !sessionParamsRef.current) {
              multiplayerService.disconnect();
              return;
            }
            reconnectAttemptRef.current = 0;
            setReconnectAttempt(0);
            setIsConnected(true);
            setConnectionStatus('connected');
            multiplayerService.clearSyncDedupeCaches();
            showToastRef.current('Reconnected to collaborative session');
          })
          .catch(() => {
            isReconnectingInFlightRef.current = false;
            if (!intentionalDisconnectRef.current && sessionParamsRef.current) {
              scheduleReconnectRef.current(false);
            }
          });
      }, delay);
    },
    [clearReconnectTimer, resetSessionState]
  );
  scheduleReconnectRef.current = scheduleReconnect;

  // Retry immediately if the browser reports network connectivity restored while reconnecting
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const handleOnline = () => {
      if (
        !intentionalDisconnectRef.current &&
        sessionParamsRef.current &&
        !multiplayerService.isConnected() &&
        !isReconnectingInFlightRef.current
      ) {
        reconnectAttemptRef.current = Math.max(0, reconnectAttemptRef.current - 1);
        scheduleReconnectRef.current(true);
      }
    };
    window.addEventListener('online', handleOnline);
    return () => window.removeEventListener('online', handleOnline);
  }, []);

  // Clean up timers on unmount
  useEffect(() => {
    return () => {
      intentionalDisconnectRef.current = true;
      clearReconnectTimer();
    };
  }, [clearReconnectTimer]);

  // Handle incoming messages & unexpected close
  useEffect(() => {
    const unsubscribe = multiplayerService.onMessage((msg: MultiplayerMessage) => {
      if (
        msg.type !== 'CANVAS_PING' &&
        msg.senderId !== undefined &&
        peerIdEquals(msg.senderId, myPeerRef.current.id)
      ) {
        return;
      }

      // Track highest applied authoritative seq for reconnect catch-up
      if (typeof msg.seq === 'number' && Number.isSafeInteger(msg.seq) && msg.seq > lastAppliedSeqRef.current) {
        lastAppliedSeqRef.current = msg.seq;
      }

      // Defense-in-depth validation against rogue viewer / unauthorized layer mutations
      const senderPeer =
        msg.senderId !== undefined
          ? peersRef.current.find((p) => peerIdEquals(p.id, msg.senderId))
          : undefined;
      const permCheck = validateIncomingRemoteMutation(msg, senderPeer, layersRef.current);
      if (!permCheck.allowed) {
        return;
      }

      switch (msg.type) {
        case 'ROOM_INFO': {
          // Do not leapfrog lastAppliedSeq before missed reconnect ops arrive
          if (
            typeof msg.serverSeq === 'number' &&
            !pendingReconnectCatchUpRef.current &&
            lastAppliedSeqRef.current === 0
          ) {
            lastAppliedSeqRef.current = msg.serverSeq;
            multiplayerService.updateServerSeq(msg.serverSeq);
          }
          break;
        }

        case 'ACCESS_DENIED': {
          const denied = msg as AccessDeniedMessage;
          if (
            denied.targetPeerId !== undefined &&
            !peerIdEquals(denied.targetPeerId, myPeerRef.current.id)
          ) {
            return;
          }
          if (denied.code === 'BANNED' || denied.code === 'KICKED') {
            intentionalDisconnectRef.current = true;
            multiplayerService.disconnect();
            resetSessionState();
          }
          showToastRef.current(denied.reason || 'Access denied');
          break;
        }

        case 'PEER_ROLE_UPDATE': {
          const roleMsg = msg as PeerRoleUpdateMessage;
          const nextRole = normalizeRole(roleMsg.role, false);
          if (nextRole === 'host') break; // Guests cannot be promoted to host via this event

          peerRolesRef.current.set(String(roleMsg.targetPeerId), nextRole);

          if (peerIdEquals(roleMsg.targetPeerId, myPeerRef.current.id)) {
            if (!isHostRef.current) {
              applyLocalRole(nextRole);
              showToastRef.current(
                nextRole === 'viewer'
                  ? 'Your role was changed to Viewer (read-only)'
                  : 'Your role was changed to Editor'
              );
            }
          } else {
            setPeers((prev) => {
              const next = prev.map((p) =>
                peerIdEquals(p.id, roleMsg.targetPeerId) ? { ...p, role: nextRole } : p
              );
              peersRef.current = next;
              return next;
            });
          }
          break;
        }

        case 'PEER_KICK':
        case 'PEER_BAN': {
          const modMsg = msg as PeerKickMessage | PeerBanMessage;
          const isBan = modMsg.type === 'PEER_BAN';

          if (peerIdEquals(modMsg.targetPeerId, myPeerRef.current.id)) {
            intentionalDisconnectRef.current = true;
            multiplayerService.disconnect();
            resetSessionState();
            showToastRef.current(
              modMsg.reason ||
                (isBan
                  ? 'You have been banned from this room by the host'
                  : 'You were removed from this room by the host')
            );
            break;
          }

          if (isBan && isHostRef.current) {
            const key = String(modMsg.targetPeerId);
            if (!bannedPeerIdsRef.current.has(key)) {
              bannedPeerIdsRef.current.add(key);
              setBannedPeerIds(Array.from(bannedPeerIdsRef.current));
            }
          }

          onRemotePeerLeftRef.current?.(modMsg.targetPeerId);
          setPeers((prev) => {
            const target = prev.find((p) => peerIdEquals(p.id, modMsg.targetPeerId));
            if (target) {
              showToastRef.current(
                isBan ? `${target.name} was banned` : `${target.name} was kicked`
              );
            }
            const next = prev.filter((p) => !peerIdEquals(p.id, modMsg.targetPeerId));
            peersRef.current = next;
            return next;
          });
          break;
        }

        case 'PEER_UNBAN': {
          const unbanMsg = msg as PeerUnbanMessage;
          const key = String(unbanMsg.targetPeerId);
          if (bannedPeerIdsRef.current.delete(key)) {
            setBannedPeerIds(Array.from(bannedPeerIdsRef.current));
          }
          break;
        }

        case 'JOIN_REQUEST': {
          // Host fallback handler when server is a dumb relay (stateful Rust server handles this directly)
          if (msg.peer && isHostRef.current) {
            const rawGuest = msg.peer;
            const guestIdKey = String(rawGuest.id);

            if (bannedPeerIdsRef.current.has(guestIdKey)) {
              multiplayerService.sendAccessDenied(
                'BANNED',
                'You are banned from this room',
                rawGuest.id
              );
              break;
            }

            const assignedRole: CollabRole =
              peerRolesRef.current.get(guestIdKey) === 'viewer' ? 'viewer' : 'editor';
            peerRolesRef.current.set(guestIdKey, assignedRole);

            const guestPeer: CollabPeer = {
              ...rawGuest,
              isHost: false,
              role: assignedRole,
            };

            setPeers((prev) => {
              const filtered = prev.filter((p) => !peerIdEquals(p.id, guestPeer.id));
              const next = [...filtered, guestPeer];
              peersRef.current = next;
              return next;
            });

            if (!msg.isReconnect) {
              showToastRef.current(`${guestPeer.name} joined the canvas`);
            }

            let assignedLayerId: string | undefined;
            let effectiveLayers = layersRef.current;

            if (assignedRole !== 'viewer' && onRemoteJoinRequestRef.current) {
              const existingOwned = effectiveLayers.find(
                (l) => l.id === `layer-${guestPeer.id}-1`
              );
              if (existingOwned) {
                assignedLayerId = existingOwned.id;
              } else {
                const res = onRemoteJoinRequestRef.current(guestPeer);
                if (res) {
                  assignedLayerId = res.assignedLayerId;
                  effectiveLayers = res.updatedLayers;
                }
              }
            }

            const roomName = hostInfoRef.current?.roomName || 'Studio';

            const joinAcceptedMsg: JoinAcceptedMessage = {
              type: 'JOIN_ACCEPTED',
              targetPeerId: guestPeer.id,
              roomName,
              peers: [
                ...peersRef.current.filter((p) => !peerIdEquals(p.id, guestPeer.id)),
                { ...myPeerRef.current, isHost: true, role: 'host' },
              ],
              hostId: myPeerRef.current.id,
              docDimensions: dimensionsRef.current,
              colorMode: colorModeRef.current,
              assignedLayerId,
              assignedRole,
              isReconnect: Boolean(msg.isReconnect),
            };
            multiplayerService.sendMessage(joinAcceptedMsg);

            multiplayerService.clearSyncDedupeCaches();

            const wireLayers = effectiveLayers.map(serializeLayerForWire);
            const wireAnim = animationTimelineRef.current
              ? { ...animationTimelineRef.current, isPlaying: false }
              : null;
            multiplayerService.sendMessage({
              type: 'DOC_SYNC_RESPONSE',
              targetPeerId: guestPeer.id,
              roomName,
              assignedLayerId,
              dimensions: dimensionsRef.current,
              colorMode: colorModeRef.current,
              layers: wireLayers,
              perspectiveRuler: perspectiveRulerRef.current,
              straightRuler: straightRulerRef.current,
              animationTimeline: wireAnim,
            });

            streamTilesPaced(effectiveLayers, guestPeer.id);

            for (const layer of effectiveLayers) {
              if (layer.maskCanvas) {
                multiplayerService.sendLayerMaskData(
                  layer.id,
                  layer.maskCanvas,
                  undefined,
                  guestPeer.id
                );
              }
            }

            multiplayerService.sendMessage({
              type: 'PEER_JOINED',
              peer: guestPeer,
            });
          }
          break;
        }

        case 'JOIN_ACCEPTED': {
          const accMsg = msg as JoinAcceptedMessage;
          if (accMsg.targetPeerId && !peerIdEquals(accMsg.targetPeerId, myPeerRef.current.id)) {
            return;
          }

          const wasReconnect = Boolean(accMsg.isReconnect || pendingReconnectCatchUpRef.current);
          pendingReconnectCatchUpRef.current = false;

          if (accMsg.assignedRole && !isHostRef.current) {
            applyLocalRole(normalizeRole(accMsg.assignedRole, false));
          }

          const allOtherPeers = (accMsg.peers || [])
            .filter((p) => !peerIdEquals(p.id, myPeerRef.current.id))
            .map((p) => ({
              ...p,
              role: normalizeRole(p.role, p.isHost),
            }));
          setPeers(allOtherPeers);
          peersRef.current = allOtherPeers;

          if (accMsg.assignedLayerId && !wasReconnect) {
            onRemoteAssignedLayerRef.current?.(accMsg.assignedLayerId);
          }

          if (!wasReconnect) {
            showToastRef.current(`Connected to room "${accMsg.roomName}"`);
          }
          break;
        }

        case 'PEER_JOINED': {
          if (msg.peer && !peerIdEquals(msg.peer.id, myPeerRef.current.id)) {
            const normalizedPeer: CollabPeer = {
              ...msg.peer,
              role: normalizeRole(msg.peer.role, msg.peer.isHost),
            };
            multiplayerService.clearSyncDedupeCaches();
            setPeers((prev) => {
              const existed = prev.some((p) => peerIdEquals(p.id, normalizedPeer.id));
              const next = [
                ...prev.filter((p) => !peerIdEquals(p.id, normalizedPeer.id)),
                normalizedPeer,
              ];
              peersRef.current = next;
              if (!existed) {
                showToastRef.current(`${normalizedPeer.name} joined the canvas`);
              }
              return next;
            });
          }
          break;
        }

        case 'PEER_LEFT':
        case 'PEER_DISCONNECTED': {
          const id = (msg as any).peerId ?? (msg as any).clientId;
          if (id === undefined || id === null) break;
          onRemotePeerLeftRef.current?.(id);
          setPeers((prev) => {
            const leaving = prev.find((p) => peerIdEquals(p.id, id));
            if (leaving) {
              showToastRef.current(`${leaving.name} left the canvas`);
            }
            const next = prev.filter((p) => !peerIdEquals(p.id, id));
            peersRef.current = next;
            return next;
          });
          break;
        }

        case 'CURSOR_MOVE': {
          const cMsg = msg as CursorMoveMessage;
          setPeers((prev) => {
            const existing = prev.find((p) => peerIdEquals(p.id, cMsg.peerId));
            if (!existing) {
              const newPeer: CollabPeer = {
                id: cMsg.peerId,
                name: cMsg.peerName || 'Guest',
                color: cMsg.peerColor || getRandomColor(),
                role: 'editor',
                x: cMsg.x,
                y: cMsg.y,
                isDrawing: cMsg.isDrawing,
                tool: cMsg.tool,
                lastActive: Date.now(),
              };
              const next = [...prev, newPeer];
              peersRef.current = next;
              return next;
            }

            const next = prev.map((p) =>
              peerIdEquals(p.id, cMsg.peerId)
                ? {
                    ...p,
                    name: cMsg.peerName || p.name,
                    color: cMsg.peerColor || p.color,
                    x: cMsg.x,
                    y: cMsg.y,
                    isDrawing: cMsg.isDrawing,
                    tool: cMsg.tool,
                    lastActive: Date.now(),
                  }
                : p
            );
            peersRef.current = next;
            return next;
          });
          break;
        }

        case 'STROKE_START': {
          const sMsg = msg as StrokeStartMessage;
          setPeers((prev) => {
            if (prev.some((p) => peerIdEquals(p.id, sMsg.peerId))) return prev;
            const newPeer: CollabPeer = {
              id: sMsg.peerId,
              name: sMsg.peerName || 'Guest',
              color: sMsg.peerColor || getRandomColor(),
              role: 'editor',
              isDrawing: true,
              tool: sMsg.tool,
              lastActive: Date.now(),
            };
            const next = [...prev, newPeer];
            peersRef.current = next;
            return next;
          });
          onRemoteStrokeStartRef.current?.(sMsg);
          break;
        }

        case 'STROKE_CHUNK': {
          onRemoteStrokeChunkRef.current?.(msg as StrokeChunkMessage);
          break;
        }

        case 'STROKE_FINISH': {
          onRemoteStrokeFinishRef.current?.(msg as StrokeFinishMessage);
          break;
        }

        case 'BRUSH_ASSET_DATA': {
          const aMsg = msg as BrushAssetDataMessage;
          registerRemoteBrushAsset(aMsg.hash, aMsg.mime, aMsg.data);
          break;
        }

        case 'BRUSH_ASSET_REQUEST': {
          const rMsg = msg as BrushAssetRequestMessage;
          if (
            rMsg.targetPeerId !== undefined &&
            !peerIdEquals(rMsg.targetPeerId, myPeerRef.current.id)
          ) {
            break;
          }
          const rec = getBrushAssetRecord(rMsg.hash);
          if (rec) {
            multiplayerService.sendBrushAssetData(rec.hash, rec.mime, rec.bytes);
          }
          break;
        }

        case 'LAYER_ADD':
        case 'LAYER_DELETE':
        case 'LAYER_CLEAR':
        case 'LAYER_RENAME':
        case 'LAYER_VISIBILITY':
        case 'LAYER_OPACITY':
        case 'LAYER_UPDATE':
        case 'LAYER_TREE_SYNC': {
          if (msg.type === 'LAYER_TREE_SYNC' && typeof msg.seq === 'number') {
            if (msg.seq < docFieldSeqRef.current.layerTree) break;
            docFieldSeqRef.current.layerTree = msg.seq;
          }
          onRemoteLayerActionRef.current?.(msg);
          break;
        }

        case 'BINARY_MASK': {
          onRemoteMaskDataRef.current?.(msg as LayerMaskDataMessage);
          break;
        }

        case 'PERSPECTIVE_RULER_SYNC': {
          if (typeof msg.seq === 'number') {
            if (msg.seq < docFieldSeqRef.current.perspectiveRuler) break;
            docFieldSeqRef.current.perspectiveRuler = msg.seq;
          }
          onRemotePerspectiveRulerRef.current?.(msg.perspectiveRuler ?? null);
          break;
        }

        case 'STRAIGHT_RULER_SYNC': {
          if (typeof msg.seq === 'number') {
            if (msg.seq < docFieldSeqRef.current.straightRuler) break;
            docFieldSeqRef.current.straightRuler = msg.seq;
          }
          onRemoteStraightRulerRef.current?.(msg.straightRuler ?? null);
          break;
        }

        case 'ANIMATION_SYNC': {
          if (typeof msg.seq === 'number') {
            if (msg.seq < docFieldSeqRef.current.animationTimeline) break;
            docFieldSeqRef.current.animationTimeline = msg.seq;
          }
          onRemoteAnimationSyncRef.current?.(msg.animationTimeline ?? null);
          break;
        }

        case 'CANVAS_RESIZE': {
          if (typeof msg.seq === 'number') {
            if (msg.seq < docFieldSeqRef.current.canvasResize) break;
            docFieldSeqRef.current.canvasResize = msg.seq;
          }
          onRemoteCanvasResizeRef.current?.(msg.dimensions, msg.options);
          break;
        }

        case 'DOC_SYNC_RESPONSE': {
          if (msg.targetPeerId && !peerIdEquals(msg.targetPeerId, myPeerRef.current.id)) {
            return;
          }
          const isReconnectSync = pendingReconnectCatchUpRef.current;
          pendingReconnectCatchUpRef.current = false;

          const snapSeq = typeof msg.seq === 'number' ? msg.seq : 0;
          if (snapSeq > lastAppliedSeqRef.current) {
            lastAppliedSeqRef.current = snapSeq;
          }
          tileSeqMapRef.current.clear();
          tileVersionMapRef.current.clear();
          docFieldSeqRef.current = {
            layerTree: snapSeq,
            perspectiveRuler: snapSeq,
            straightRuler: snapSeq,
            animationTimeline: snapSeq,
            canvasResize: snapSeq,
          };
          if (onRemoteDocSyncRef.current && msg.layers) {
            onRemoteDocSyncRef.current(
              msg.dimensions,
              msg.colorMode,
              msg.layers,
              msg.assignedLayerId,
              msg.roomName,
              msg.perspectiveRuler ?? null,
              msg.straightRuler ?? null,
              msg.animationTimeline ?? null,
              isReconnectSync
            );
          }
          break;
        }

        case 'CANVAS_PING': {
          const pingId = `ping-${Date.now()}-${Math.random()}`;
          setActivePings((prev) => [
            ...prev,
            { id: pingId, x: msg.x, y: msg.y, color: msg.sender.color, name: msg.sender.name },
          ]);
          setTimeout(() => {
            setActivePings((prev) => prev.filter((p) => p.id !== pingId));
          }, 2400);
          break;
        }

        case 'BINARY_TILE': {
          const tMsg = msg as TileStreamMessage;
          const tileKey = `${tMsg.layerId}:${tMsg.tileX}:${tMsg.tileY}`;
          if (typeof tMsg.seq === 'number') {
            const prevSeq = tileSeqMapRef.current.get(tileKey);
            if (prevSeq !== undefined && tMsg.seq < prevSeq) {
              break;
            }
            if (prevSeq !== undefined && tMsg.seq === prevSeq) {
              const prevVer = tileVersionMapRef.current.get(tileKey);
              if (prevVer !== undefined && tMsg.version <= prevVer) {
                break;
              }
            }
            tileSeqMapRef.current.set(tileKey, tMsg.seq);
            tileVersionMapRef.current.set(tileKey, tMsg.version);
          } else {
            const prevVer = tileVersionMapRef.current.get(tileKey);
            if (
              tMsg.data !== null &&
              prevVer !== undefined &&
              tMsg.version > 0 &&
              tMsg.version <= prevVer
            ) {
              break;
            }
            if (tMsg.data === null) {
              tileVersionMapRef.current.delete(tileKey);
            } else if (tMsg.version > 0) {
              tileVersionMapRef.current.set(tileKey, tMsg.version);
            }
          }

          const activeGrid = documentStore.getActiveTileGrid();
          activeGrid.markLayerIngested(tMsg.layerId);
          if (tMsg.data === null) {
            activeGrid.deleteTile(tMsg.layerId, tMsg.tileX, tMsg.tileY, 0);
            activeGrid.bumpLayerVersion(tMsg.layerId);
            activeGrid.notifyChange(true);
            onRemoteTileAppliedRef.current?.(tMsg.layerId);
            break;
          }
          const tile: TileBuffer = {
            layerId: tMsg.layerId,
            tileX: tMsg.tileX,
            tileY: tMsg.tileY,
            format: tMsg.format,
            version: tMsg.version,
            data: tMsg.data,
            dirty: true,
            isPagedToDisk: false,
            lastAccessTimestamp: typeof performance !== 'undefined' ? performance.now() : Date.now(),
            lod: 0,
          };
          activeGrid.setTile(tMsg.layerId, tMsg.tileX, tMsg.tileY, tile);
          activeGrid.notifyChange(true);
          onRemoteTileAppliedRef.current?.(tMsg.layerId);
          break;
        }

        case 'SELECTIVE_UNDO': {
          const uMsg = msg as SelectiveUndoMessage;
          onRemoteSelectiveUndoRef.current?.(uMsg.strokeId, uMsg.peerId);
          break;
        }
      }
    });

    // Unexpected close: keep session state & seq cursors, reconnect with exponential backoff
    const unsubClose = multiplayerService.onClose((reason?: string) => {
      if (intentionalDisconnectRef.current || !sessionParamsRef.current) {
        resetSessionState();
        return;
      }

      // If the P2P host explicitly closed the room, notify cleanly without endless retries
      if (
        sessionParamsRef.current.kind === 'webrtc-guest' &&
        reason &&
        /host closed/i.test(reason)
      ) {
        intentionalDisconnectRef.current = true;
        resetSessionState();
        showToastRef.current('Host ended the P2P room. Your canvas remains open locally.');
        return;
      }

      setIsConnected(false);
      setConnectionStatus('reconnecting');
      if (reconnectAttemptRef.current === 0) {
        showToastRef.current(
          sessionParamsRef.current.kind === 'webrtc-guest'
            ? 'Host connection interrupted. Reconnecting to P2P room...'
            : 'Connection lost. Reconnecting...'
        );
      }
      scheduleReconnectRef.current(false);
    });

    return () => {
      unsubscribe();
      unsubClose();
    };
  }, [applyLocalRole, resetSessionState, streamTilesPaced]);

  // SMART CLIPBOARD INVITATION DETECTION
  useEffect(() => {
    const checkClipboardForInvite = async () => {
      if (isConnected || connectionStatus === 'reconnecting') return;

      try {
        if (!navigator.clipboard || !navigator.clipboard.readText) return;
        const text = await navigator.clipboard.readText();
        if (!text || text === lastProcessedClipboardUrlRef.current) return;

        const parsed = parseCollabTarget(text);
        if (parsed) {
          lastProcessedClipboardUrlRef.current = text;
          setClipboardInvite(parsed);
        }
      } catch {
        // Clipboard read permission might be denied or window not focused
      }
    };

    window.addEventListener('focus', checkClipboardForInvite);
    return () => window.removeEventListener('focus', checkClipboardForInvite);
  }, [isConnected, connectionStatus]);

  // Check URL query parameters on initial page load (for Web Browser joins)
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const parsed = parseCollabTarget(window.location.href);
    if (parsed) {
      setWebLandingInvite(parsed);
    }
  }, []);

  // START HOSTING
  const startHosting = useCallback(
    async (
      roomName: string = 'Ink Studio Session',
      port: number = 30303,
      hostNickname?: string,
      isGlobal: boolean = true,
      onStatus?: (status: string) => void
    ) => {
      try {
        clearReconnectTimer();
        intentionalDisconnectRef.current = false;
        reconnectAttemptRef.current = 0;
        setReconnectAttempt(0);
        setConnectionStatus('connecting');

        let currentName = myPeerRef.current.name;
        if (hostNickname && hostNickname.trim()) {
          currentName = hostNickname.trim();
        }

        let serverInfo: SessionHostInfo;

        if (isTauriEnvironment()) {
          const { invoke } = await import('@tauri-apps/api/core');
          if (isGlobal) {
            const installed = await invoke<boolean>('is_cloudflared_installed').catch(() => true);
            if (!installed) {
              onStatus?.('Downloading Cloudflare Tunnel (first time)...');
            } else {
              onStatus?.('Starting Worldwide Tunnel...');
            }
          } else {
            onStatus?.('Starting Local Server...');
          }
          serverInfo = await invoke<SessionHostInfo>('start_collab_server', {
            port,
            roomName,
            enableTunnel: isGlobal,
          });
        } else {
          const host = window.location.hostname || '127.0.0.1';
          serverInfo = {
            isRunning: true,
            port,
            localIp: host,
            roomName,
            inviteUrl: `http://${host}:${port}/?room=${encodeURIComponent(roomName)}`,
            peerCount: 1,
            isGlobal: false,
          };
        }

        const resolvedPort = serverInfo.port || port;
        const resolvedIp = serverInfo.localIp || (serverInfo as any).local_ip || '127.0.0.1';
        const resolvedRoomName = serverInfo.roomName || (serverInfo as any).room_name || roomName;
        const resolvedRoomToken = serverInfo.roomToken || (serverInfo as any).room_token || '';
        const tokenQuery = resolvedRoomToken
          ? `&token=${encodeURIComponent(resolvedRoomToken)}`
          : '';
        const resolvedInviteUrl =
          serverInfo.inviteUrl ||
          (serverInfo as any).invite_url ||
          `http://${resolvedIp}:${resolvedPort}/?room=${encodeURIComponent(resolvedRoomName)}${tokenQuery}`;
        const isGlobalServer = Boolean(serverInfo.isGlobal ?? (serverInfo as any).is_global);
        const localInviteUrl = serverInfo.localInviteUrl || (serverInfo as any).local_invite_url;

        const normalizedServerInfo: SessionHostInfo = {
          isRunning: true,
          port: resolvedPort,
          localIp: resolvedIp,
          roomName: resolvedRoomName,
          roomToken: resolvedRoomToken || undefined,
          inviteUrl: resolvedInviteUrl,
          peerCount: serverInfo.peerCount || 1,
          isGlobal: isGlobalServer,
          localInviteUrl,
          transport: 'ws',
        };

        setHostInfo(normalizedServerInfo);
        setIsHost(true);
        isHostRef.current = true;
        hostInfoRef.current = normalizedServerInfo;

        bannedPeerIdsRef.current.clear();
        setBannedPeerIds([]);
        peerRolesRef.current.clear();
        lastAppliedSeqRef.current = 0;
        tileSeqMapRef.current.clear();
        tileVersionMapRef.current.clear();
        pendingReconnectCatchUpRef.current = false;

        const hostPeer: CollabPeer = {
          ...myPeerRef.current,
          name: currentName,
          isHost: true,
          role: 'host',
        };
        setMyPeer(hostPeer);
        myPeerRef.current = hostPeer;
        myRoleRef.current = 'host';
        setMyRole('host');
        multiplayerService.setLocalRole('host');

        // Host connects locally via 127.0.0.1 with the room token
        const wsUrl = `ws://127.0.0.1:${resolvedPort}/ws`;
        sessionParamsRef.current = {
          kind: 'ws',
          wsUrl,
          token: resolvedRoomToken || undefined,
          roomName: resolvedRoomName,
          host: '127.0.0.1',
          port: resolvedPort,
          isSecure: false,
          isHost: true,
        };

        await multiplayerService.connect(wsUrl, hostPeer, resolvedRoomToken || undefined);
        setIsConnected(true);
        setConnectionStatus('connected');

        // Seed the stateful server immediately so joining peers sync directly from the server
        const initialLayers = layersRef.current;
        const wireLayers = initialLayers.map(serializeLayerForWire);
        const wireAnim = animationTimelineRef.current
          ? { ...animationTimelineRef.current, isPlaying: false }
          : null;
        multiplayerService.sendMessage({
          type: 'DOC_SYNC_RESPONSE',
          targetPeerId: '__server__',
          roomName: resolvedRoomName,
          dimensions: dimensionsRef.current,
          colorMode: colorModeRef.current,
          layers: wireLayers,
          perspectiveRuler: perspectiveRulerRef.current,
          straightRuler: straightRulerRef.current,
          animationTimeline: wireAnim,
        });
        streamTilesPaced(initialLayers);
        for (const layer of initialLayers) {
          if (layer.maskCanvas) {
            multiplayerService.sendLayerMaskData(layer.id, layer.maskCanvas);
          }
        }

        // Auto-copy invite link
        try {
          await navigator.clipboard.writeText(normalizedServerInfo.inviteUrl);
          lastProcessedClipboardUrlRef.current = normalizedServerInfo.inviteUrl;
          showToast(
            isGlobalServer
              ? 'Worldwide invite link copied to clipboard.'
              : 'Local Wi-Fi invite link copied to clipboard.'
          );
        } catch {
          showToast(`Room created: ${normalizedServerInfo.inviteUrl}`);
        }

        return normalizedServerInfo;
      } catch (err: any) {
        console.error('Failed to start host session:', err);
        resetSessionState();
        const errMsg = err?.message || (typeof err === 'string' ? err : 'Connection error');
        showToast(`Failed to start host: ${errMsg}`);
        throw err;
      }
    },
    [clearReconnectTimer, resetSessionState, showToast, streamTilesPaced]
  );

  // START QUICK P2P HOSTING (SERVERLESS WEBRTC STAR HUB, NO CLOUDFLARED REQUIRED)
  const startWebRtcHosting = useCallback(
    async (
      roomName: string = 'Ink Studio Session',
      hostNickname?: string,
      onStatus?: (status: string) => void
    ): Promise<SessionHostInfo> => {
      try {
        clearReconnectTimer();
        intentionalDisconnectRef.current = false;
        reconnectAttemptRef.current = 0;
        setReconnectAttempt(0);
        setConnectionStatus('connecting');

        let currentName = myPeerRef.current.name;
        if (hostNickname && hostNickname.trim()) {
          currentName = hostNickname.trim();
        }

        const resolvedRoomName = roomName.trim() || 'Ink Studio Session';
        const creds = generateP2pRoomCredentials();
        const { customSignalingUrl, turnConfig } = getWebRtcNetworkConfigFromSettings();

        onStatus?.('Connecting to P2P signaling...');

        const hostPeer: CollabPeer = {
          ...myPeerRef.current,
          name: currentName,
          isHost: true,
          role: 'host',
        };

        const hub = new WebRtcHostHub({
          roomHash: creds.roomHash,
          hostPeerId: String(hostPeer.id),
          customSignalingUrl,
          turnConfig,
        });

        await hub.start();

        const shareUrl = buildP2pShareUrl(
          creds.roomCode,
          creds.roomSecret,
          resolvedRoomName,
          customSignalingUrl
        );

        const normalizedServerInfo: SessionHostInfo = {
          isRunning: true,
          port: 0,
          localIp: 'WebRTC P2P',
          roomName: resolvedRoomName,
          roomToken: creds.roomSecret,
          inviteUrl: shareUrl,
          peerCount: 1,
          isGlobal: true,
          transport: 'webrtc',
          roomCode: creds.roomCode,
          roomSecret: creds.roomSecret,
          joinCode: creds.joinCode,
        };

        setHostInfo(normalizedServerInfo);
        setIsHost(true);
        isHostRef.current = true;
        hostInfoRef.current = normalizedServerInfo;

        bannedPeerIdsRef.current.clear();
        setBannedPeerIds([]);
        peerRolesRef.current.clear();
        lastAppliedSeqRef.current = 0;
        tileSeqMapRef.current.clear();
        tileVersionMapRef.current.clear();
        pendingReconnectCatchUpRef.current = false;

        setMyPeer(hostPeer);
        myPeerRef.current = hostPeer;
        myRoleRef.current = 'host';
        setMyRole('host');
        multiplayerService.setLocalRole('host');

        sessionParamsRef.current = null;
        multiplayerService.attachTransport(hub, hostPeer, { sendJoinRequest: false });

        setIsConnected(true);
        setConnectionStatus('connected');

        // Auto-copy short join code (graceful fallback if clipboard blocked)
        try {
          if (navigator.clipboard && navigator.clipboard.writeText) {
            await navigator.clipboard.writeText(creds.joinCode);
            lastProcessedClipboardUrlRef.current = creds.joinCode;
            showToast(`Quick P2P room ready! Code ${creds.joinCode} copied.`);
          } else {
            showToast(`Quick P2P room ready: ${creds.joinCode}`);
          }
        } catch {
          showToast(`Quick P2P room ready: ${creds.joinCode}`);
        }

        return normalizedServerInfo;
      } catch (err: any) {
        console.error('Failed to start WebRTC P2P host session:', err);
        resetSessionState();
        const errMsg = err?.message || (typeof err === 'string' ? err : 'P2P connection error');
        showToast(`Failed to start P2P room: ${errMsg}`);
        throw err;
      }
    },
    [clearReconnectTimer, resetSessionState, showToast]
  );

  // STOP HOSTING
  const stopHosting = useCallback(async () => {
    try {
      const wasWebRtc = hostInfoRef.current?.transport === 'webrtc';
      intentionalDisconnectRef.current = true;
      clearReconnectTimer();
      multiplayerService.disconnect();
      if (!wasWebRtc && isTauriEnvironment()) {
        const { invoke } = await import('@tauri-apps/api/core');
        await invoke('stop_collab_server');
      }
      resetSessionState();
      showToast('Collaborative session stopped');
    } catch (err) {
      console.error('Failed to stop collab server:', err);
    }
  }, [clearReconnectTimer, resetSessionState, showToast]);

  // JOIN ROOM
  const joinRoom = useCallback(
    async (
      host: string,
      port: number,
      roomName: string,
      guestNickname?: string,
      token?: string,
      isSecureOverride?: boolean,
      persistName: boolean = false,
      wsPath?: string
    ): Promise<boolean> => {
      try {
        clearReconnectTimer();
        intentionalDisconnectRef.current = false;
        reconnectAttemptRef.current = 0;
        setReconnectAttempt(0);
        setConnectionStatus('connecting');

        let currentName = myPeerRef.current.name;
        if (guestNickname && guestNickname.trim()) {
          currentName = guestNickname.trim();
          if (persistName) {
            safeLocalStorageSetItem(NICKNAME_KEY, currentName, 'artist name');
            safeLocalStorageSetItem(NICKNAME_CUSTOMIZED_KEY, '1', 'artist name flag');
          }
        }

        const isHttps = typeof window !== 'undefined' && window.location.protocol === 'https:';
        const isSecure =
          isSecureOverride !== undefined
            ? isSecureOverride
            : isHttps || port === 443 || host.toLowerCase().endsWith('.trycloudflare.com');
        const proto = isSecure ? 'wss' : 'ws';
        const portPart = port === 80 || port === 443 || !port ? '' : `:${port}`;
        const normalizedPath = wsPath && wsPath.startsWith('/') ? wsPath : '/ws';
        const wsUrl = `${proto}://${host}${portPart}${normalizedPath}`;

        const guestPeer: CollabPeer = {
          ...myPeerRef.current,
          name: currentName,
          isHost: false,
          role: 'editor',
        };
        setMyPeer(guestPeer);
        myPeerRef.current = guestPeer;
        myRoleRef.current = 'editor';
        setMyRole('editor');
        multiplayerService.setLocalRole('editor');

        lastAppliedSeqRef.current = 0;
        tileSeqMapRef.current.clear();
        tileVersionMapRef.current.clear();
        pendingReconnectCatchUpRef.current = false;

        sessionParamsRef.current = {
          kind: 'ws',
          wsUrl,
          token,
          roomName,
          host,
          port,
          isSecure,
          isHost: false,
        };

        await multiplayerService.connect(wsUrl, guestPeer, token);
        setIsConnected(true);
        setConnectionStatus('connected');
        setIsHost(false);
        isHostRef.current = false;

        const inviteProto = isSecure ? 'https' : 'http';
        const tokenQuery = token ? `&token=${encodeURIComponent(token)}` : '';
        const nextHostInfo: SessionHostInfo = {
          isRunning: true,
          port,
          localIp: host,
          roomName,
          roomToken: token,
          inviteUrl: `${inviteProto}://${host}${portPart}/?room=${encodeURIComponent(roomName)}${tokenQuery}`,
          peerCount: 1,
          isGlobal: isSecure,
          transport: 'ws',
        };
        setHostInfo(nextHostInfo);
        hostInfoRef.current = nextHostInfo;
        setClipboardInvite(null);
        setWebLandingInvite(null);
        return true;
      } catch (err: any) {
        resetSessionState();
        showToast(`Failed to connect: ${err?.message || err}`);
        return false;
      }
    },
    [clearReconnectTimer, resetSessionState, showToast]
  );

  // JOIN WORLDWIDE P2P ROOM (WEBRTC GUEST)
  const joinWebRtcRoom = useCallback(
    async (
      rawRoomCode: string,
      rawRoomSecret: string = '',
      guestNickname?: string,
      signalingUrlOverride?: string,
      persistName: boolean = false,
      roomNameOverride?: string
    ): Promise<boolean> => {
      try {
        clearReconnectTimer();
        intentionalDisconnectRef.current = false;
        reconnectAttemptRef.current = 0;
        setReconnectAttempt(0);
        setConnectionStatus('connecting');

        const roomCode = normalizeRoomCode(rawRoomCode);
        const roomSecret = normalizeRoomSecret(rawRoomSecret);
        const roomHash = computeRoomTopicHash(roomCode, roomSecret);
        const joinCode = roomSecret ? `${roomCode}-${roomSecret}` : roomCode;
        const resolvedRoomName = (roomNameOverride || roomCode).trim() || roomCode;

        let currentName = myPeerRef.current.name;
        if (guestNickname && guestNickname.trim()) {
          currentName = guestNickname.trim();
          if (persistName) {
            safeLocalStorageSetItem(NICKNAME_KEY, currentName, 'artist name');
            safeLocalStorageSetItem(NICKNAME_CUSTOMIZED_KEY, '1', 'artist name flag');
          }
        }

        const guestPeer: CollabPeer = {
          ...myPeerRef.current,
          name: currentName,
          isHost: false,
          role: 'editor',
        };
        setMyPeer(guestPeer);
        myPeerRef.current = guestPeer;
        myRoleRef.current = 'editor';
        setMyRole('editor');
        multiplayerService.setLocalRole('editor');

        lastAppliedSeqRef.current = 0;
        tileSeqMapRef.current.clear();
        tileVersionMapRef.current.clear();
        pendingReconnectCatchUpRef.current = false;

        const { customSignalingUrl, turnConfig } =
          getWebRtcNetworkConfigFromSettings(signalingUrlOverride);

        sessionParamsRef.current = {
          kind: 'webrtc-guest',
          roomCode,
          roomSecret,
          roomHash,
          roomName: resolvedRoomName,
          customSignalingUrl,
          isHost: false,
        };

        const guestClient = new WebRtcGuestClient({
          roomHash,
          peerId: String(guestPeer.id),
          customSignalingUrl,
          turnConfig,
        });

        await guestClient.connect();
        multiplayerService.attachTransport(guestClient, guestPeer, {
          sendJoinRequest: true,
        });

        setIsConnected(true);
        setConnectionStatus('connected');
        setIsHost(false);
        isHostRef.current = false;

        const nextHostInfo: SessionHostInfo = {
          isRunning: true,
          port: 0,
          localIp: 'WebRTC P2P',
          roomName: resolvedRoomName,
          roomToken: roomSecret || undefined,
          inviteUrl: buildP2pShareUrl(roomCode, roomSecret, resolvedRoomName, customSignalingUrl),
          peerCount: 1,
          isGlobal: true,
          transport: 'webrtc',
          roomCode,
          roomSecret: roomSecret || undefined,
          joinCode,
        };
        setHostInfo(nextHostInfo);
        hostInfoRef.current = nextHostInfo;
        setClipboardInvite(null);
        setWebLandingInvite(null);
        return true;
      } catch (err: any) {
        resetSessionState();
        showToast(`Failed to join P2P room: ${err?.message || err}`);
        return false;
      }
    },
    [clearReconnectTimer, resetSessionState, showToast]
  );

  const joinByInviteUrl = useCallback(
    async (
      rawUrl: string,
      nickname?: string,
      persistName: boolean = false,
      secretOverride?: string
    ): Promise<boolean> => {
      const target = parseCollabTarget(rawUrl);
      if (!target) {
        showToast(
          'Invalid room code or link. Enter an INK-XXXX code, P2P link, or wss:// / ws:// URL.'
        );
        return false;
      }
      if (target.kind === 'p2p') {
        const effectiveSecret =
          secretOverride !== undefined && secretOverride.trim()
            ? secretOverride.trim()
            : target.roomSecret;
        return joinWebRtcRoom(
          target.roomCode,
          effectiveSecret,
          nickname,
          target.signalingUrl,
          persistName,
          target.roomName
        );
      }
      return joinRoom(
        target.host,
        target.port,
        target.roomName,
        nickname,
        target.token,
        target.isSecure,
        persistName,
        target.wsPath
      );
    },
    [joinRoom, joinWebRtcRoom, showToast]
  );

  const leaveRoom = useCallback(() => {
    intentionalDisconnectRef.current = true;
    clearReconnectTimer();
    multiplayerService.disconnect();
    resetSessionState();
    showToast('Left the collaborative session');
  }, [clearReconnectTimer, resetSessionState, showToast]);

  // HOST MODERATION: ROLE CHANGE, KICK, BAN, UNBAN
  const setPeerRole = useCallback(
    (peerId: string | number, role: Exclude<CollabRole, 'host'>) => {
      if (!isHostRef.current) {
        showToast('Only the Host can change participant roles');
        return;
      }
      if (peerIdEquals(peerId, myPeerRef.current.id)) return;

      peerRolesRef.current.set(String(peerId), role);
      setPeers((prev) => {
        const next = prev.map((p) => (peerIdEquals(p.id, peerId) ? { ...p, role } : p));
        peersRef.current = next;
        return next;
      });
      multiplayerService.sendPeerRoleUpdate(peerId, role);
    },
    [showToast]
  );

  const kickPeer = useCallback(
    (peerId: string | number, reason?: string) => {
      if (!isHostRef.current) {
        showToast('Only the Host can kick participants');
        return;
      }
      if (peerIdEquals(peerId, myPeerRef.current.id)) return;

      multiplayerService.sendPeerKick(peerId, reason);
      onRemotePeerLeftRef.current?.(peerId);
      setPeers((prev) => {
        const target = prev.find((p) => peerIdEquals(p.id, peerId));
        if (target) {
          showToast(`Kicked ${target.name} from the room`);
        }
        const next = prev.filter((p) => !peerIdEquals(p.id, peerId));
        peersRef.current = next;
        return next;
      });
    },
    [showToast]
  );

  const banPeer = useCallback(
    (peerId: string | number, reason?: string) => {
      if (!isHostRef.current) {
        showToast('Only the Host can ban participants');
        return;
      }
      if (peerIdEquals(peerId, myPeerRef.current.id)) return;

      const key = String(peerId);
      bannedPeerIdsRef.current.add(key);
      setBannedPeerIds(Array.from(bannedPeerIdsRef.current));

      multiplayerService.sendPeerBan(peerId, reason);
      onRemotePeerLeftRef.current?.(peerId);
      setPeers((prev) => {
        const target = prev.find((p) => peerIdEquals(p.id, peerId));
        if (target) {
          showToast(`Banned ${target.name} from the room`);
        }
        const next = prev.filter((p) => !peerIdEquals(p.id, peerId));
        peersRef.current = next;
        return next;
      });
    },
    [showToast]
  );

  const unbanPeer = useCallback(
    (peerId: string | number) => {
      if (!isHostRef.current) {
        showToast('Only the Host can unban participants');
        return;
      }
      const key = String(peerId);
      if (bannedPeerIdsRef.current.delete(key)) {
        setBannedPeerIds(Array.from(bannedPeerIdsRef.current));
        multiplayerService.sendPeerUnban(peerId);
        showToast(`Unbanned ${key}`);
      }
    },
    [showToast]
  );

  const updateMyName = useCallback((name: string, markCustomized: boolean = true) => {
    const fallback = isTauriEnvironment() ? 'Artist' : 'Guest';
    const trimmed = name.trim() || fallback;
    if (markCustomized) {
      safeLocalStorageSetItem(NICKNAME_KEY, trimmed, 'artist name');
      safeLocalStorageSetItem(NICKNAME_CUSTOMIZED_KEY, '1', 'artist name flag');
      const curSettings = useUiStore.getState().appSettings;
      if (curSettings.userName !== trimmed) {
        uiStoreActions.updateAppSettings({ ...curSettings, userName: trimmed });
      }
    }
    setMyPeer((prev) => {
      const next = { ...prev, name: trimmed };
      myPeerRef.current = next;
      return next;
    });
  }, []);

  const updateMyColor = useCallback((color: string) => {
    setMyPeer((prev) => {
      const next = { ...prev, color };
      myPeerRef.current = next;
      return next;
    });
  }, []);

  const sendPing = useCallback((x: number, y: number) => {
    multiplayerService.sendPing(x, y);
  }, []);

  return {
    isConnected,
    connectionStatus,
    isReconnecting: connectionStatus === 'reconnecting',
    reconnectAttempt,
    isHost,
    myRole,
    hostInfo,
    peers,
    bannedPeerIds,
    myPeer,
    activePings,
    clipboardInvite,
    setClipboardInvite,
    webLandingInvite,
    setWebLandingInvite,
    isHostModalOpen,
    setIsHostModalOpen,
    startHosting,
    startWebRtcHosting,
    stopHosting,
    joinRoom,
    joinWebRtcRoom,
    joinByInviteUrl,
    leaveRoom,
    setPeerRole,
    kickPeer,
    banPeer,
    unbanPeer,
    updateMyName,
    updateMyColor,
    sendPing,
  };
}
