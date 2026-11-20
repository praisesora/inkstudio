import { useState, useEffect, useCallback, useRef } from 'react';
import { safeLocalStorageSetItem } from '../utils/safeStorage';
import {
  CollabPeer,
  SessionHostInfo,
  MultiplayerMessage,
  StrokeStartMessage,
  StrokeChunkMessage,
  StrokeFinishMessage,
  CursorMoveMessage,
  JoinAcceptedMessage,
  TileStreamMessage,
  SelectiveUndoMessage,
} from '../types/multiplayer';
import {
  multiplayerService,
  ParsedInviteLink,
  parseInviteUrl,
} from '../services/multiplayerService';
import { LayerItem, CanvasDimensions, CanvasColorMode } from '../types/editor';
import { TILE_SIZE, TileBuffer } from '../utils/tileEngine';
import { documentStore } from '../utils/documentStore';
import { uiStoreActions, useUiStore } from '../stores';

const NICKNAME_KEY = 'sora_paint_nickname';
const NICKNAME_CUSTOMIZED_KEY = 'ink_nickname_customized';

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
    // Desktop: will be replaced by OS username via get_os_username on mount
    return 'Artist';
  } catch {
    return isTauriEnvironment() ? 'Artist' : 'Guest';
  }
}

export interface UseMultiplayerProps {
  dimensions: CanvasDimensions;
  colorMode: CanvasColorMode;
  layers: LayerItem[];
  layerCanvasesRef: React.MutableRefObject<Map<string, HTMLCanvasElement>>;
  onRemoteStrokeStart?: (msg: StrokeStartMessage) => void;
  onRemoteStrokeChunk?: (msg: StrokeChunkMessage) => void;
  onRemoteStrokeFinish?: (msg: StrokeFinishMessage) => void;
  onRemoteLayerAction?: (msg: MultiplayerMessage) => void;
  onRemoteDocSync?: (
    dimensions: CanvasDimensions,
    colorMode: CanvasColorMode,
    layers: LayerItem[],
    dataUrls: Record<string, string>,
    assignedLayerId?: string,
    roomName?: string
  ) => void;
  onRemoteJoinRequest?: (
    peer: CollabPeer
  ) => { assignedLayerId: string; updatedLayers: LayerItem[] } | void;
  onRemoteAssignedLayer?: (layerId: string) => void;
  onRemoteSelectiveUndo?: (strokeId: string, peerId: string | number) => void;
  showToast: (msg: string) => void;
}

export function useMultiplayer({
  dimensions,
  colorMode,
  layers,
  layerCanvasesRef,
  onRemoteStrokeStart,
  onRemoteStrokeChunk,
  onRemoteStrokeFinish,
  onRemoteLayerAction,
  onRemoteDocSync,
  onRemoteJoinRequest,
  onRemoteAssignedLayer,
  onRemoteSelectiveUndo,
  showToast,
}: UseMultiplayerProps) {
  const [isConnected, setIsConnected] = useState(false);
  const [isHost, setIsHost] = useState(false);
  const [hostInfo, setHostInfo] = useState<SessionHostInfo | null>(null);
  const [peers, setPeers] = useState<CollabPeer[]>([]);
  const peersRef = useRef<CollabPeer[]>([]);

  const [myPeer, setMyPeer] = useState<CollabPeer>(() => ({
    id: `peer-${Date.now()}-${Math.random().toString(36).substring(2, 6)}`,
    name: getInitialPeerName(),
    color: getRandomColor(),
  }));
  const myPeerRef = useRef(myPeer);

  const [activePings, setActivePings] = useState<
    Array<{ id: string; x: number; y: number; color: string; name: string }>
  >([]);
  const [isHostModalOpen, setIsHostModalOpen] = useState(false);

  // Smart Clipboard Invitation Prompt
  const [clipboardInvite, setClipboardInvite] = useState<ParsedInviteLink | null>(null);
  const lastProcessedClipboardUrlRef = useRef<string | null>(null);

  // Web Landing modal for browser guests visiting via ?room=...
  const [webLandingInvite, setWebLandingInvite] = useState<ParsedInviteLink | null>(null);

  // Synchronous refs for event handlers
  const dimensionsRef = useRef(dimensions);
  const colorModeRef = useRef(colorMode);
  const layersRef = useRef(layers);
  const isHostRef = useRef(isHost);
  const hostInfoRef = useRef(hostInfo);

  dimensionsRef.current = dimensions;
  colorModeRef.current = colorMode;
  layersRef.current = layers;
  isHostRef.current = isHost;
  hostInfoRef.current = hostInfo;
  myPeerRef.current = myPeer;
  peersRef.current = peers;

  // Keep callback refs
  const onRemoteStrokeStartRef = useRef(onRemoteStrokeStart);
  const onRemoteStrokeChunkRef = useRef(onRemoteStrokeChunk);
  const onRemoteStrokeFinishRef = useRef(onRemoteStrokeFinish);
  const onRemoteLayerActionRef = useRef(onRemoteLayerAction);
  const onRemoteDocSyncRef = useRef(onRemoteDocSync);
  const onRemoteJoinRequestRef = useRef(onRemoteJoinRequest);
  const onRemoteAssignedLayerRef = useRef(onRemoteAssignedLayer);
  const onRemoteSelectiveUndoRef = useRef(onRemoteSelectiveUndo);
  const showToastRef = useRef(showToast);

  onRemoteStrokeStartRef.current = onRemoteStrokeStart;
  onRemoteStrokeChunkRef.current = onRemoteStrokeChunk;
  onRemoteStrokeFinishRef.current = onRemoteStrokeFinish;
  onRemoteLayerActionRef.current = onRemoteLayerAction;
  onRemoteDocSyncRef.current = onRemoteDocSync;
  onRemoteJoinRequestRef.current = onRemoteJoinRequest;
  onRemoteAssignedLayerRef.current = onRemoteAssignedLayer;
  onRemoteSelectiveUndoRef.current = onRemoteSelectiveUndo;
  showToastRef.current = showToast;

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
          if (!curSettings.userName || curSettings.userName === 'Sora') {
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
  const streamTilesPaced = useCallback((layersToStream: LayerItem[]) => {
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
        multiplayerService.sendTileDelta(entry.layerId, entry.tile);
      }
      if (idx < queue.length) {
        setTimeout(pump, 4);
      }
    };

    pump();
  }, []);

  // Handle incoming messages
  useEffect(() => {
    const unsubscribe = multiplayerService.onMessage((msg: MultiplayerMessage) => {
      switch (msg.type) {
        case 'ROOM_INFO': {
          break;
        }

        case 'JOIN_REQUEST': {
          // Only the host processes join requests; other guests will receive PEER_JOINED
          if (msg.peer && isHostRef.current) {
            const guestPeer = msg.peer;

            setPeers((prev) => {
              const filtered = prev.filter((p) => p.id !== guestPeer.id);
              const next = [...filtered, guestPeer];
              peersRef.current = next;
              return next;
            });

            showToastRef.current(`${guestPeer.name} joined the canvas`);

            let assignedLayerId: string | undefined;
            let effectiveLayers = layersRef.current;

            // Delegate layer creation to the host application
            if (onRemoteJoinRequestRef.current) {
              const res = onRemoteJoinRequestRef.current(guestPeer);
              if (res) {
                assignedLayerId = res.assignedLayerId;
                effectiveLayers = res.updatedLayers;
              }
            }

            const roomName = hostInfoRef.current?.roomName || 'Studio';

            // Send JOIN_ACCEPTED to the joining guest
            const joinAcceptedMsg: JoinAcceptedMessage = {
              type: 'JOIN_ACCEPTED',
              targetPeerId: guestPeer.id,
              roomName,
              peers: [...peersRef.current.filter((p) => p.id !== guestPeer.id), myPeerRef.current],
              hostId: myPeerRef.current.id,
              docDimensions: dimensionsRef.current,
              colorMode: colorModeRef.current,
              assignedLayerId,
            };
            multiplayerService.sendMessage(joinAcceptedMsg);

            // Send document synchronization (carries assignedLayerId & roomName so there is no race)
            multiplayerService.sendMessage({
              type: 'DOC_SYNC_RESPONSE',
              targetPeerId: guestPeer.id,
              roomName,
              assignedLayerId,
              dimensions: dimensionsRef.current,
              colorMode: colorModeRef.current,
              layers: effectiveLayers,
              layerDataUrls: {},
            });

            // Progressive paced tile streaming from active document's sparse tile grid
            streamTilesPaced(effectiveLayers);

            // Broadcast PEER_JOINED to other already connected peers
            multiplayerService.sendMessage({
              type: 'PEER_JOINED',
              peer: guestPeer,
            });
          }
          break;
        }

        case 'JOIN_ACCEPTED': {
          const accMsg = msg as JoinAcceptedMessage;
          if (accMsg.targetPeerId && accMsg.targetPeerId !== myPeerRef.current.id) {
            return;
          }

          // Store all peers (host + existing guests)
          const allOtherPeers = (accMsg.peers || []).filter((p) => p.id !== myPeerRef.current.id);
          setPeers(allOtherPeers);
          peersRef.current = allOtherPeers;

          if (accMsg.assignedLayerId) {
            onRemoteAssignedLayerRef.current?.(accMsg.assignedLayerId);
          }

          showToastRef.current(`Connected to room "${accMsg.roomName}"`);
          break;
        }

        case 'PEER_JOINED': {
          if (msg.peer && msg.peer.id !== myPeerRef.current.id) {
            setPeers((prev) => {
              const next = [...prev.filter((p) => p.id !== msg.peer.id), msg.peer];
              peersRef.current = next;
              return next;
            });
            showToastRef.current(`${msg.peer.name} joined the canvas`);
          }
          break;
        }

        case 'PEER_LEFT':
        case 'PEER_DISCONNECTED': {
          const id = (msg as any).peerId ?? (msg as any).clientId;
          if (id === undefined || id === null) break;
          setPeers((prev) => {
            const leaving = prev.find((p) => String(p.id) === String(id));
            if (leaving) {
              showToastRef.current(`${leaving.name} left the canvas`);
            }
            const next = prev.filter((p) => String(p.id) !== String(id));
            peersRef.current = next;
            return next;
          });
          break;
        }

        case 'CURSOR_MOVE': {
          const cMsg = msg as CursorMoveMessage;
          setPeers((prev) => {
            const existing = prev.find((p) => p.id === cMsg.peerId);
            if (!existing) {
              const newPeer: CollabPeer = {
                id: cMsg.peerId,
                name: cMsg.peerName || 'Guest',
                color: cMsg.peerColor || getRandomColor(),
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
              p.id === cMsg.peerId
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
            if (prev.some((p) => p.id === sMsg.peerId)) return prev;
            const newPeer: CollabPeer = {
              id: sMsg.peerId,
              name: sMsg.peerName || 'Guest',
              color: sMsg.peerColor || getRandomColor(),
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

        case 'LAYER_ADD':
        case 'LAYER_DELETE':
        case 'LAYER_CLEAR':
        case 'LAYER_RENAME':
        case 'LAYER_VISIBILITY':
        case 'LAYER_OPACITY': {
          onRemoteLayerActionRef.current?.(msg);
          break;
        }

        case 'DOC_SYNC_RESPONSE': {
          if (msg.targetPeerId && msg.targetPeerId !== myPeerRef.current.id) {
            return;
          }
          if (onRemoteDocSyncRef.current && msg.layers) {
            onRemoteDocSyncRef.current(
              msg.dimensions,
              msg.colorMode,
              msg.layers,
              msg.layerDataUrls || {},
              msg.assignedLayerId,
              msg.roomName
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
          const activeGrid = documentStore.getActiveTileGrid();
          activeGrid.setTile(tMsg.layerId, tMsg.tileX, tMsg.tileY, tile);
          const canvas = layerCanvasesRef.current.get(tMsg.layerId);
          if (canvas) {
            activeGrid.renderLayerToCanvas(tMsg.layerId, canvas, {
              x: tMsg.tileX * TILE_SIZE,
              y: tMsg.tileY * TILE_SIZE,
              width: TILE_SIZE,
              height: TILE_SIZE,
            });
          }
          activeGrid.notifyChange(true);
          break;
        }

        case 'SELECTIVE_UNDO': {
          const uMsg = msg as SelectiveUndoMessage;
          onRemoteSelectiveUndoRef.current?.(uMsg.strokeId, uMsg.peerId);
          break;
        }
      }
    });

    const unsubClose = multiplayerService.onClose(() => {
      setIsConnected(false);
      setIsHost(false);
      setPeers([]);
      peersRef.current = [];
      showToastRef.current('Disconnected from collaborative session');
    });

    return () => {
      unsubscribe();
      unsubClose();
    };
  }, [layerCanvasesRef, streamTilesPaced]);

  // SMART CLIPBOARD INVITATION DETECTION
  useEffect(() => {
    const checkClipboardForInvite = async () => {
      if (isConnected) return;

      try {
        if (!navigator.clipboard || !navigator.clipboard.readText) return;
        const text = await navigator.clipboard.readText();
        if (!text || text === lastProcessedClipboardUrlRef.current) return;

        const parsed = parseInviteUrl(text);
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
  }, [isConnected]);

  // Check URL query parameters on initial page load (for Web Browser joins)
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const parsed = parseInviteUrl(window.location.href);
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
        };

        setHostInfo(normalizedServerInfo);
        setIsHost(true);
        isHostRef.current = true;
        hostInfoRef.current = normalizedServerInfo;

        const hostPeer: CollabPeer = {
          ...myPeerRef.current,
          name: currentName,
          isHost: true,
        };
        setMyPeer(hostPeer);
        myPeerRef.current = hostPeer;

        // Host connects locally via 127.0.0.1 with the room token
        const wsUrl = `ws://127.0.0.1:${resolvedPort}/ws`;
        await multiplayerService.connect(wsUrl, hostPeer, resolvedRoomToken || undefined);
        setIsConnected(true);

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
        const errMsg = err?.message || (typeof err === 'string' ? err : 'Connection error');
        showToast(`Failed to start host: ${errMsg}`);
        throw err;
      }
    },
    [showToast]
  );

  // STOP HOSTING
  const stopHosting = useCallback(async () => {
    try {
      multiplayerService.disconnect();
      if (isTauriEnvironment()) {
        const { invoke } = await import('@tauri-apps/api/core');
        await invoke('stop_collab_server');
      }
      setIsConnected(false);
      setIsHost(false);
      isHostRef.current = false;
      setHostInfo(null);
      hostInfoRef.current = null;
      setPeers([]);
      peersRef.current = [];
      showToast('Collaborative session stopped');
    } catch (err) {
      console.error('Failed to stop collab server:', err);
    }
  }, [showToast]);

  // JOIN ROOM
  const joinRoom = useCallback(
    async (
      host: string,
      port: number,
      roomName: string,
      guestNickname?: string,
      token?: string,
      isSecureOverride?: boolean,
      persistName: boolean = false
    ): Promise<boolean> => {
      try {
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
        const wsUrl = `${proto}://${host}${portPart}/ws`;

        const guestPeer: CollabPeer = {
          ...myPeerRef.current,
          name: currentName,
          isHost: false,
        };
        setMyPeer(guestPeer);
        myPeerRef.current = guestPeer;

        await multiplayerService.connect(wsUrl, guestPeer, token);
        setIsConnected(true);
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
        };
        setHostInfo(nextHostInfo);
        hostInfoRef.current = nextHostInfo;
        setClipboardInvite(null);
        setWebLandingInvite(null);
        return true;
      } catch (err: any) {
        showToast(`Failed to connect: ${err?.message || err}`);
        return false;
      }
    },
    [showToast]
  );

  const joinByInviteUrl = useCallback(
    async (rawUrl: string, nickname?: string, persistName: boolean = false): Promise<boolean> => {
      const parsed = parseInviteUrl(rawUrl);
      if (!parsed) {
        showToast('Invalid invite link. Paste the full room URL.');
        return false;
      }
      return joinRoom(
        parsed.host,
        parsed.port,
        parsed.roomName,
        nickname,
        parsed.token,
        parsed.isSecure,
        persistName
      );
    },
    [joinRoom, showToast]
  );

  const leaveRoom = useCallback(() => {
    multiplayerService.disconnect();
    setIsConnected(false);
    setIsHost(false);
    isHostRef.current = false;
    setHostInfo(null);
    hostInfoRef.current = null;
    setPeers([]);
    peersRef.current = [];
    showToast('Left the collaborative session');
  }, [showToast]);

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
    isHost,
    hostInfo,
    peers,
    myPeer,
    activePings,
    clipboardInvite,
    setClipboardInvite,
    webLandingInvite,
    setWebLandingInvite,
    isHostModalOpen,
    setIsHostModalOpen,
    startHosting,
    stopHosting,
    joinRoom,
    joinByInviteUrl,
    leaveRoom,
    updateMyName,
    updateMyColor,
    sendPing,
  };
}
