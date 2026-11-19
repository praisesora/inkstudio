import { useState, useEffect, useCallback, useRef } from 'react';
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
import { multiplayerService } from '../services/multiplayerService';
import { LayerItem, CanvasDimensions, CanvasColorMode } from '../types/editor';
import { TILE_SIZE, TileBuffer } from '../utils/tileEngine';
import { documentStore } from '../utils/documentStore';

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
  return Boolean((window as any).__TAURI_INTERNALS__ || (window as any).__TAURI__ || (window as any).isTauri);
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
  onRemoteDocSync?: (dimensions: CanvasDimensions, colorMode: CanvasColorMode, layers: LayerItem[], dataUrls: Record<string, string>) => void;
  onRemoteJoinRequest?: (peer: CollabPeer) => { assignedLayerId: string; updatedLayers: LayerItem[] } | void;
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

  const [myPeer, setMyPeer] = useState<CollabPeer>(() => {
    const savedName = (typeof window !== 'undefined' && localStorage.getItem('sora_paint_nickname')) || 'Sora';
    return {
      id: `peer-${Date.now()}-${Math.random().toString(36).substring(2, 6)}`,
      name: savedName,
      color: getRandomColor(),
    };
  });
  const myPeerRef = useRef(myPeer);

  const [activePings, setActivePings] = useState<Array<{ id: string; x: number; y: number; color: string; name: string }>>([]);
  const [isHostModalOpen, setIsHostModalOpen] = useState(false);

  // Smart Clipboard Invitation Prompt
  const [clipboardInvite, setClipboardInvite] = useState<{
    roomName: string;
    host: string;
    port: number;
    url: string;
  } | null>(null);
  const lastProcessedClipboardUrlRef = useRef<string | null>(null);

  // Web Landing modal for browser guests visiting via ?room=...
  const [webLandingInvite, setWebLandingInvite] = useState<{
    roomName: string;
    host: string;
    port: number;
    url: string;
  } | null>(null);

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
              if (prev.some((p) => p.id === guestPeer.id)) return prev;
              const next = [...prev, guestPeer];
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

            // Send JOIN_ACCEPTED to the joining guest
            const joinAcceptedMsg: JoinAcceptedMessage = {
              type: 'JOIN_ACCEPTED',
              targetPeerId: guestPeer.id,
              roomName: hostInfoRef.current?.roomName || 'Studio',
              peers: [...peersRef.current.filter((p) => p.id !== guestPeer.id), myPeerRef.current],
              hostId: myPeerRef.current.id,
              docDimensions: dimensionsRef.current,
              colorMode: colorModeRef.current,
              assignedLayerId,
            };
            multiplayerService.sendMessage(joinAcceptedMsg);

            // Send document synchronization
            multiplayerService.sendMessage({
              type: 'DOC_SYNC_RESPONSE',
              targetPeerId: guestPeer.id,
              dimensions: dimensionsRef.current,
              colorMode: colorModeRef.current,
              layers: effectiveLayers,
              layerDataUrls: {},
            });

            // Progressive Tile Streaming: stream active layer tiles progressively from active document's sparse tile grid
            const activeGrid = documentStore.getActiveTileGrid();
            for (const layer of effectiveLayers) {
              const tiles = activeGrid.getLayerTiles(layer.id);
              for (const tile of tiles) {
                multiplayerService.sendTileDelta(layer.id, tile);
              }
            }

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

          showToastRef.current(`Connected to room "${accMsg.roomName}"!`);
          break;
        }

        case 'PEER_JOINED': {
          if (msg.peer && msg.peer.id !== myPeerRef.current.id) {
            setPeers((prev) => {
              const next = [...prev.filter((p) => p.id !== msg.peer.id), msg.peer];
              peersRef.current = next;
              return next;
            });
            showToastRef.current(`🎨 ${msg.peer.name} joined the canvas`);
          }
          break;
        }

        case 'PEER_LEFT':
        case 'PEER_DISCONNECTED': {
          const id = (msg as any).peerId || (msg as any).clientId;
          setPeers((prev) => {
            const leaving = prev.find((p) => p.id === id);
            if (leaving) {
              showToastRef.current(`👋 ${leaving.name} left the canvas`);
            }
            const next = prev.filter((p) => p.id !== id);
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
              // Dynamically register peer if not yet in list so cursor and draft canvas exist
              const newPeer: CollabPeer = {
                id: cMsg.peerId,
                name: cMsg.peerName || 'Friend',
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
              name: sMsg.peerName || 'Friend',
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
            onRemoteDocSyncRef.current(msg.dimensions, msg.colorMode, msg.layers, msg.layerDataUrls || {});
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
      setPeers([]);
      peersRef.current = [];
    });

    return () => {
      unsubscribe();
      unsubClose();
    };
  }, [layerCanvasesRef]);

  // SMART CLIPBOARD INVITATION DETECTION
  useEffect(() => {
    const checkClipboardForInvite = async () => {
      if (isConnected) return;

      try {
        if (!navigator.clipboard || !navigator.clipboard.readText) return;
        const text = await navigator.clipboard.readText();
        if (!text || text === lastProcessedClipboardUrlRef.current) return;

        const httpMatch = text.match(/https?:\/\/([^:/]+)(?::([0-9]+))?\/?[?&]room=([^&]+)/i);
        const protocolMatch = text.match(/forsora:\/\/join\?host=([^&]+)&port=([0-9]+)(?:&room=([^&]+))?/i);

        if (httpMatch) {
          const host = httpMatch[1];
          const isHttps = text.startsWith('https://');
          const port = httpMatch[2] ? parseInt(httpMatch[2], 10) : (isHttps ? 443 : 80);
          const roomName = decodeURIComponent(httpMatch[3]);
          lastProcessedClipboardUrlRef.current = text;
          setClipboardInvite({ roomName, host, port, url: text });
        } else if (protocolMatch) {
          const host = protocolMatch[1];
          const port = parseInt(protocolMatch[2], 10);
          const roomName = protocolMatch[3] ? decodeURIComponent(protocolMatch[3]) : 'Studio';
          lastProcessedClipboardUrlRef.current = text;
          setClipboardInvite({ roomName, host, port, url: text });
        }
      } catch {
        // Clipboard read permission might be denied or window not focused, ignore silently
      }
    };

    window.addEventListener('focus', checkClipboardForInvite);
    return () => window.removeEventListener('focus', checkClipboardForInvite);
  }, [isConnected]);

  // Check URL query parameters on initial page load (for Web Browser joins)
  useEffect(() => {
    if (typeof window === 'undefined') return;

    const params = new URLSearchParams(window.location.search);
    const room = params.get('room');
    if (room) {
      const host = window.location.hostname || '127.0.0.1';
      const isHttps = window.location.protocol === 'https:';
      const port = window.location.port ? parseInt(window.location.port, 10) : (isHttps ? 443 : 80);
      setWebLandingInvite({
        roomName: decodeURIComponent(room),
        host,
        port,
        url: window.location.href,
      });
    }
  }, []);

  // START HOSTING
  const startHosting = useCallback(
    async (
      roomName: string = "Ink Studio Session",
      port: number = 30303,
      hostNickname?: string,
      isGlobal: boolean = true
    ) => {
      try {
        let currentName = myPeer.name;
        if (hostNickname && hostNickname.trim()) {
          currentName = hostNickname.trim();
          if (typeof window !== 'undefined') {
            localStorage.setItem('sora_paint_nickname', currentName);
          }
        }

        let serverInfo: SessionHostInfo;

        if (isTauriEnvironment()) {
          const { invoke } = await import('@tauri-apps/api/core');
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
        const resolvedInviteUrl =
          serverInfo.inviteUrl ||
          (serverInfo as any).invite_url ||
          `http://${resolvedIp}:${resolvedPort}/?room=${encodeURIComponent(resolvedRoomName)}`;
        const isGlobalServer = Boolean(serverInfo.isGlobal ?? (serverInfo as any).is_global);
        const localInviteUrl = serverInfo.localInviteUrl || (serverInfo as any).local_invite_url;

        const normalizedServerInfo: SessionHostInfo = {
          isRunning: true,
          port: resolvedPort,
          localIp: resolvedIp,
          roomName: resolvedRoomName,
          inviteUrl: resolvedInviteUrl,
          peerCount: serverInfo.peerCount || 1,
          isGlobal: isGlobalServer,
          localInviteUrl,
        };

        setHostInfo(normalizedServerInfo);
        setIsHost(true);

        const hostPeer: CollabPeer = {
          ...myPeer,
          name: currentName,
          isHost: true,
        };
        setMyPeer(hostPeer);
        myPeerRef.current = hostPeer;

        // Host connects locally via 127.0.0.1
        const wsUrl = `ws://127.0.0.1:${resolvedPort}/ws`;
        await multiplayerService.connect(wsUrl, hostPeer);
        setIsConnected(true);

        // Auto-copy invite link
        try {
          await navigator.clipboard.writeText(normalizedServerInfo.inviteUrl);
          showToast(
            isGlobalServer
              ? '🌍 Global room invite link copied! Friends worldwide can join.'
              : '🔗 Local room invite link copied to clipboard!'
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
    [myPeer, showToast]
  );

  // STOP HOSTING
  const stopHosting = useCallback(async () => {
    try {
      if (isTauriEnvironment()) {
        const { invoke } = await import('@tauri-apps/api/core');
        await invoke('stop_collab_server');
      }
      multiplayerService.disconnect();
      setIsConnected(false);
      setIsHost(false);
      setHostInfo(null);
      setPeers([]);
      peersRef.current = [];
      showToast('Collaborative drawing session stopped');
    } catch (err) {
      console.error('Failed to stop collab server:', err);
    }
  }, [showToast]);

  // JOIN ROOM
  const joinRoom = useCallback(
    async (host: string, port: number, roomName: string, guestNickname?: string) => {
      try {
        let currentName = myPeer.name;
        if (guestNickname && guestNickname.trim()) {
          currentName = guestNickname.trim();
          if (typeof window !== 'undefined') {
            localStorage.setItem('sora_paint_nickname', currentName);
          }
        }

        const isHttps = typeof window !== 'undefined' && window.location.protocol === 'https:';
        const isSecure = isHttps || port === 443 || host.includes('trycloudflare.com');
        const proto = isSecure ? 'wss' : 'ws';
        const portPart = port === 80 || port === 443 || !port ? '' : `:${port}`;
        const wsUrl = `${proto}://${host}${portPart}/ws`;

        const guestPeer: CollabPeer = {
          ...myPeer,
          name: currentName,
          isHost: false,
        };
        setMyPeer(guestPeer);
        myPeerRef.current = guestPeer;

        await multiplayerService.connect(wsUrl, guestPeer);
        setIsConnected(true);
        setIsHost(false);
        const inviteProto = isSecure ? 'https' : 'http';
        setHostInfo({
          isRunning: true,
          port,
          localIp: host,
          roomName,
          inviteUrl: `${inviteProto}://${host}${portPart}/?room=${encodeURIComponent(roomName)}`,
          peerCount: 1,
          isGlobal: isSecure,
        });
        setClipboardInvite(null);
        setWebLandingInvite(null);
        showToast(`Connecting to room "${roomName}"...`);
      } catch (err: any) {
        showToast(`Failed to connect: ${err?.message || err}`);
      }
    },
    [myPeer, showToast]
  );

  const leaveRoom = useCallback(() => {
    multiplayerService.disconnect();
    setIsConnected(false);
    setIsHost(false);
    setHostInfo(null);
    setPeers([]);
    peersRef.current = [];
    showToast('You left the room');
  }, [showToast]);

  const updateMyName = useCallback((name: string) => {
    const trimmed = name.trim() || 'Artist';
    if (typeof window !== 'undefined') {
      localStorage.setItem('sora_paint_nickname', trimmed);
    }
    setMyPeer((prev) => ({ ...prev, name: trimmed }));
  }, []);

  const updateMyColor = useCallback((color: string) => {
    setMyPeer((prev) => ({ ...prev, color }));
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
    leaveRoom,
    updateMyName,
    updateMyColor,
    sendPing,
  };
}
