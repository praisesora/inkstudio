import {
  AccessDeniedCode,
  AccessDeniedMessage,
  AnimationSyncMessage,
  BrushAssetDataMessage,
  BrushAssetRequestMessage,
  CanvasPingMessage,
  CanvasResizeMessage,
  CollabPeer,
  CollabRole,
  CursorMoveMessage,
  DocSyncResponseMessage,
  LayerActionMessage,
  LayerClearableField,
  LayerMaskDataMessage,
  LayerTreeSyncMessage,
  LayerUpdateMessage,
  MultiplayerMessage,
  PeerBanMessage,
  PeerKickMessage,
  PeerRoleUpdateMessage,
  PeerUnbanMessage,
  PerspectiveRulerSyncMessage,
  SelectiveUndoMessage,
  StraightRulerSyncMessage,
  StrokeChunkMessage,
  StrokeFinishMessage,
  StrokeStartMessage,
  TileStreamMessage,
  WireLayerItem,
} from '../types/multiplayer';
import {
  AnimationTimeline,
  BrushSettings,
  CanvasDimensions,
  DirtyRect,
  LayerItem,
  Point,
  TileDelta,
  ToolType,
  VectorStroke,
} from '../types/editor';
import { PerspectiveRuler, StraightRuler } from '../types/perspective';
import { ResizeCanvasOptions } from '../types/settings';
import {
  SparseTileGrid,
  TileBuffer,
  parseTileKey,
  serializeTileBuffer,
  deserializeTileBufferStrict,
} from '../utils/tileEngine';
import {
  MAX_BRUSH_ASSET_BYTES,
  isAllowedBrushAssetMime,
  isValidBrushAssetHash,
  prepareBrushSettingsForWire,
  sanitizeBrushAssetRefs,
} from '../utils/brushAssetSync';
import { lz4CompressBlock, lz4DecompressBlock } from '../utils/lz4';
import {
  MAX_SYNC_CANVAS_DIM,
  extractMaskGrayscaleRect,
  sanitizeAnimationTimeline,
  sanitizeCanvasResize,
  sanitizeClearedFields,
  sanitizePerspectiveRuler,
  sanitizeStraightRuler,
  sanitizeWireLayer,
  sanitizeWireLayerPatch,
  sanitizeWireLayerTree,
  serializeLayerForWire,
} from '../utils/collabSyncUtils';
import { CollabTransportKind, ICollabTransport } from './collabTransport';
import { normalizeRoomCode, normalizeRoomSecret } from './webrtcSignaling';

type MessageHandler = (msg: MultiplayerMessage) => void;

// Binary Message Codes
export const BINARY_MAGIC_0 = 0x49; // 'I'
export const BINARY_MAGIC_1 = 0x4e; // 'N'

export const CODE_STROKE_START = 0x01;
export const CODE_STROKE_CHUNK = 0x02;
export const CODE_STROKE_FINISH = 0x03;
export const CODE_TILE_DELTA = 0x04;
export const CODE_CURSOR_MOVE = 0x05;
export const CODE_SELECTIVE_UNDO = 0x06;
export const CODE_BRUSH_ASSET_DATA = 0x07;
export const CODE_BRUSH_ASSET_REQUEST = 0x08;
export const CODE_LAYER_MASK_DATA = 0x09;

const MASK_FLAG_FULL_REPLACE = 0x01;
const MASK_FLAG_LZ4 = 0x02;
const MASK_FLAG_SOLID_FILL = 0x04;
const MAX_MASK_CHUNK_DIM = 1024;
const MAX_MASK_DECODE_BYTES = 4 * 1024 * 1024; // 4 MB safety ceiling per mask packet

const MAX_BINARY_PACKET_BYTES = 16 * 1024 * 1024;
const MAX_JSON_MESSAGE_CHARS = 8 * 1024 * 1024;
const MAX_STROKE_CHUNK_POINTS = 4096;
const STROKE_CHUNK_POINT_STRIDE = 20;
const MAX_TILE_COORD = 4096;
const WS_CONNECT_TIMEOUT_MS = 15000;
const STATE_SYNC_THROTTLE_MS = 33;

const TOOL_TYPES_LIST: ToolType[] = [
  'brush',
  'eraser',
  'pipette',
  'transform',
  'select-rect',
  'select-lasso',
  'select-wand',
  'select-pen',
  'select-eraser',
  'fill',
  'text',
  'frame',
  'balloon',
  'vector-edit',
  'liquify',
  'shape',
  'object',
  '3d',
  'gradient',
  'retouch',
  'pen',
];

export const DEEP_LINK_SCHEME = 'inkstudio:';

export interface ParsedInviteLink {
  roomName: string;
  host: string;
  port: number;
  url: string;
  token?: string;
  isSecure: boolean;
  /** Optional custom WebSocket path (defaults to "/ws" when omitted). */
  wsPath?: string;
}

export function parseInviteUrl(raw: string): ParsedInviteLink | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;

  let parsedUrl: URL;
  try {
    parsedUrl = new URL(trimmed);
  } catch {
    return null;
  }

  if (parsedUrl.protocol === 'http:' || parsedUrl.protocol === 'https:') {
    const hostname = parsedUrl.hostname.trim();
    if (!hostname) return null;
    const isTryCloudflare =
      parsedUrl.protocol === 'https:' && hostname.toLowerCase().endsWith('.trycloudflare.com');
    const roomParam = parsedUrl.searchParams.get('room');
    if (!roomParam && !isTryCloudflare) return null;
    const isSecure = parsedUrl.protocol === 'https:';
    const port = parsedUrl.port ? parseInt(parsedUrl.port, 10) : isSecure ? 443 : 80;
    if (!Number.isFinite(port) || port <= 0 || port > 65535) return null;
    const token = parsedUrl.searchParams.get('token') || undefined;
    return {
      roomName: (roomParam || 'Studio').trim() || 'Studio',
      host: hostname,
      port,
      url: trimmed,
      token,
      isSecure,
    };
  }

  if (parsedUrl.protocol === 'ws:' || parsedUrl.protocol === 'wss:') {
    const hostname = parsedUrl.hostname.trim();
    if (!hostname) return null;
    const isSecure = parsedUrl.protocol === 'wss:';
    const port = parsedUrl.port ? parseInt(parsedUrl.port, 10) : isSecure ? 443 : 80;
    if (!Number.isFinite(port) || port <= 0 || port > 65535) return null;
    const roomName = (parsedUrl.searchParams.get('room') || 'Studio').trim() || 'Studio';
    const token = parsedUrl.searchParams.get('token') || undefined;
    const pathname = parsedUrl.pathname;
    const wsPath = pathname && pathname !== '/' && pathname !== '/ws' ? pathname : undefined;
    return {
      roomName,
      host: hostname,
      port,
      url: trimmed,
      token,
      isSecure,
      ...(wsPath ? { wsPath } : {}),
    };
  }

  if (parsedUrl.protocol === DEEP_LINK_SCHEME) {
    const host = parsedUrl.searchParams.get('host');
    const portParam = parsedUrl.searchParams.get('port');
    if (!host) return null;
    const protoParam = parsedUrl.searchParams.get('protocol');
    const isSecure =
      protoParam === 'https' ||
      portParam === '443' ||
      host.toLowerCase().endsWith('.trycloudflare.com');
    const port = portParam ? parseInt(portParam, 10) : isSecure ? 443 : 30303;
    if (!Number.isFinite(port) || port <= 0 || port > 65535) return null;
    const roomName = parsedUrl.searchParams.get('room') || 'Studio';
    const token = parsedUrl.searchParams.get('token') || undefined;
    return {
      roomName,
      host,
      port,
      url: trimmed,
      token,
      isSecure,
    };
  }

  return null;
}

export interface ParsedP2pInvite {
  kind: 'p2p';
  roomCode: string;
  roomSecret: string;
  joinCode: string;
  roomName: string;
  signalingUrl?: string;
  url: string;
}

export interface ParsedWsInvite extends ParsedInviteLink {
  kind: 'ws';
}

export type ParsedCollabTarget = ParsedP2pInvite | ParsedWsInvite;

const P2P_SHORT_CODE_REGEX = /^INK-([A-Z0-9]{4,8})(?:[-:\s]+([A-Z0-9]{4,16}))?$/i;

function sanitizeSignalingUrlParam(raw: string | null): string | undefined {
  if (!raw) return undefined;
  const trimmed = raw.trim();
  if (!trimmed) return undefined;
  try {
    const parsed = new URL(trimmed);
    if (
      parsed.protocol === 'wss:' ||
      parsed.protocol === 'ws:' ||
      parsed.protocol === 'https:' ||
      parsed.protocol === 'http:'
    ) {
      return trimmed;
    }
  } catch {
    // ignore invalid signaling URL param
  }
  return undefined;
}

function splitEmbeddedP2pCode(rawCode: string, explicitSecret?: string | null): {
  roomCode: string;
  roomSecret: string;
} | null {
  const match = rawCode.trim().match(P2P_SHORT_CODE_REGEX);
  if (!match) return null;
  const roomCode = normalizeRoomCode(`INK-${match[1]}`);
  const roomSecret = normalizeRoomSecret(explicitSecret || match[2] || '');
  return { roomCode, roomSecret };
}

/**
 * Auto-detects whether user input is:
 *  - a short P2P room code (`INK-7429` or `INK-7429-K8P2M9`)
 *  - a P2P invite link (`https://.../?p2p=INK-7429&secret=...` or `inkstudio://p2p?code=...`)
 *  - a WebSocket / Cloudflare / LAN invite link (`wss://...`, `ws://...`, `https://...trycloudflare.com`, `http://.../?room=...`)
 */
export function parseCollabTarget(raw: string): ParsedCollabTarget | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;

  // 1. Bare or combined short P2P room code (e.g. INK-7429 or INK-7429-K8P2M9)
  const directCode = splitEmbeddedP2pCode(trimmed);
  if (directCode) {
    const joinCode = directCode.roomSecret
      ? `${directCode.roomCode}-${directCode.roomSecret}`
      : directCode.roomCode;
    return {
      kind: 'p2p',
      roomCode: directCode.roomCode,
      roomSecret: directCode.roomSecret,
      joinCode,
      roomName: directCode.roomCode,
      url: trimmed,
    };
  }

  // 2. P2P URL (`https://.../?p2p=INK-7429&secret=...` or `inkstudio://p2p?code=INK-7429&secret=...`)
  try {
    const parsedUrl = new URL(trimmed);
    if (parsedUrl.protocol === 'http:' || parsedUrl.protocol === 'https:') {
      const p2pParam = parsedUrl.searchParams.get('p2p');
      if (p2pParam) {
        const split = splitEmbeddedP2pCode(
          p2pParam,
          parsedUrl.searchParams.get('secret') || parsedUrl.searchParams.get('token')
        );
        if (split) {
          const roomName =
            (parsedUrl.searchParams.get('room') || split.roomCode).trim() || split.roomCode;
          const signalingUrl = sanitizeSignalingUrlParam(parsedUrl.searchParams.get('sig'));
          return {
            kind: 'p2p',
            roomCode: split.roomCode,
            roomSecret: split.roomSecret,
            joinCode: split.roomSecret ? `${split.roomCode}-${split.roomSecret}` : split.roomCode,
            roomName,
            ...(signalingUrl ? { signalingUrl } : {}),
            url: trimmed,
          };
        }
      }
    } else if (parsedUrl.protocol === DEEP_LINK_SCHEME) {
      const hostOrPath = `${parsedUrl.hostname}${parsedUrl.pathname}`.toLowerCase();
      const codeParam = parsedUrl.searchParams.get('code') || parsedUrl.searchParams.get('p2p');
      if (codeParam && (hostOrPath.includes('p2p') || parsedUrl.searchParams.has('code'))) {
        const split = splitEmbeddedP2pCode(
          codeParam,
          parsedUrl.searchParams.get('secret') || parsedUrl.searchParams.get('token')
        );
        if (split) {
          const roomName =
            (parsedUrl.searchParams.get('room') || split.roomCode).trim() || split.roomCode;
          const signalingUrl = sanitizeSignalingUrlParam(parsedUrl.searchParams.get('sig'));
          return {
            kind: 'p2p',
            roomCode: split.roomCode,
            roomSecret: split.roomSecret,
            joinCode: split.roomSecret ? `${split.roomCode}-${split.roomSecret}` : split.roomCode,
            roomName,
            ...(signalingUrl ? { signalingUrl } : {}),
            url: trimmed,
          };
        }
      }
    }
  } catch {
    // Not a URL — fall through
  }

  // 3. WebSocket / Cloudflare / LAN / inkstudio://join invite URL
  const wsInvite = parseInviteUrl(trimmed);
  if (wsInvite) {
    return {
      kind: 'ws',
      ...wsInvite,
    };
  }

  return null;
}

export function buildP2pShareUrl(
  roomCode: string,
  roomSecret: string,
  roomName: string,
  customSignalingUrl?: string
): string {
  const params = new URLSearchParams();
  const sig = sanitizeSignalingUrlParam(customSignalingUrl || null);

  const isWebHttpOrigin =
    typeof window !== 'undefined' &&
    (window.location.protocol === 'http:' || window.location.protocol === 'https:') &&
    window.location.hostname !== 'tauri.localhost' &&
    window.location.hostname !== '';

  if (isWebHttpOrigin) {
    params.set('p2p', normalizeRoomCode(roomCode));
    if (roomSecret) params.set('secret', normalizeRoomSecret(roomSecret));
    if (roomName) params.set('room', roomName);
    if (sig) params.set('sig', sig);
    return `${window.location.origin}/?${params.toString()}`;
  }

  params.set('code', normalizeRoomCode(roomCode));
  if (roomSecret) params.set('secret', normalizeRoomSecret(roomSecret));
  if (roomName) params.set('room', roomName);
  if (sig) params.set('sig', sig);
  return `${DEEP_LINK_SCHEME}//p2p?${params.toString()}`;
}

function sanitizeRemoteBrushSettings(raw: unknown): BrushSettings | null {
  if (!raw || typeof raw !== 'object') return null;
  const bs = raw as BrushSettings;
  const size = Number.isFinite(bs.size) ? Math.max(0.5, Math.min(2000, bs.size)) : 8;
  const opacity = Number.isFinite(bs.opacity) ? Math.max(0, Math.min(1, bs.opacity)) : 1;
  const flow = Number.isFinite(bs.flow) ? Math.max(0.01, Math.min(1, bs.flow)) : 1;
  const spacing = Number.isFinite(bs.spacing) ? Math.max(0.01, Math.min(2, bs.spacing)) : 0.1;
  const dynamics = bs.dynamics
    ? {
        ...bs.dynamics,
        count: Number.isFinite(bs.dynamics.count)
          ? Math.max(1, Math.min(16, Math.round(bs.dynamics.count)))
          : 1,
      }
    : undefined;
  const spray = bs.spray
    ? {
        ...bs.spray,
        density: Number.isFinite(bs.spray.density)
          ? Math.max(1, Math.min(64, Math.round(bs.spray.density)))
          : 12,
        size: Number.isFinite(bs.spray.size)
          ? Math.max(1, Math.min(200, bs.spray.size))
          : 3,
      }
    : undefined;
  const {
    customTipDataUrl: _tipUrl,
    customTipImage: _tipImg,
    dualTipDataUrl: _dualUrl,
    dualTipImage: _dualImg,
    paperTexture: _paperUrl,
    paperTextureImage: _paperImg,
    subTips: _subTips,
    subTipImages: _subImgs,
    ...rest
  } = bs;
  return {
    ...rest,
    size,
    opacity,
    flow,
    spacing,
    dynamics,
    spray,
  };
}

function isValidRemotePoint(pt: unknown): pt is Point {
  if (!pt || typeof pt !== 'object') return false;
  const p = pt as Point;
  return Number.isFinite(p.x) && Number.isFinite(p.y);
}

/**
 * Strictly validates and sanitizes untrusted remote JSON messages before dispatching.
 * Returns null to drop malformed or malicious payloads.
 */
export function sanitizeIncomingJsonMessage(raw: unknown): MultiplayerMessage | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const msg = raw as Record<string, unknown>;
  if (typeof msg.type !== 'string') return null;

  const senderId =
    typeof msg.senderId === 'string' || typeof msg.senderId === 'number'
      ? msg.senderId
      : undefined;
  const seq =
    typeof msg.seq === 'number' && Number.isSafeInteger(msg.seq) && msg.seq >= 0
      ? msg.seq
      : undefined;

  const sanitized = sanitizeIncomingJsonBody(msg, senderId);
  if (sanitized && seq !== undefined) {
    sanitized.seq = seq;
  }
  return sanitized;
}

function sanitizeIncomingJsonBody(
  msg: Record<string, unknown>,
  senderId: string | number | undefined
): MultiplayerMessage | null {
  switch (msg.type) {
    case 'LAYER_ADD': {
      const layerItem = sanitizeWireLayer(msg.layerItem);
      if (!layerItem) return null;
      const insertIndex =
        typeof msg.insertIndex === 'number' && Number.isInteger(msg.insertIndex) && msg.insertIndex >= 0
          ? msg.insertIndex
          : undefined;
      return {
        type: 'LAYER_ADD',
        senderId,
        layerId: layerItem.id,
        layerItem,
        insertIndex,
      };
    }

    case 'LAYER_DELETE':
    case 'LAYER_CLEAR': {
      if (typeof msg.layerId !== 'string' || !msg.layerId || msg.layerId.length > 256) return null;
      return {
        type: msg.type,
        senderId,
        layerId: msg.layerId,
      };
    }

    case 'LAYER_RENAME': {
      if (
        typeof msg.layerId !== 'string' ||
        !msg.layerId ||
        msg.layerId.length > 256 ||
        typeof msg.newName !== 'string'
      ) {
        return null;
      }
      return {
        type: 'LAYER_RENAME',
        senderId,
        layerId: msg.layerId,
        newName: msg.newName.slice(0, 256),
      };
    }

    case 'LAYER_VISIBILITY': {
      if (
        typeof msg.layerId !== 'string' ||
        !msg.layerId ||
        msg.layerId.length > 256 ||
        typeof msg.visible !== 'boolean'
      ) {
        return null;
      }
      return {
        type: 'LAYER_VISIBILITY',
        senderId,
        layerId: msg.layerId,
        visible: msg.visible,
      };
    }

    case 'LAYER_OPACITY': {
      if (
        typeof msg.layerId !== 'string' ||
        !msg.layerId ||
        msg.layerId.length > 256 ||
        typeof msg.opacity !== 'number' ||
        !Number.isFinite(msg.opacity)
      ) {
        return null;
      }
      return {
        type: 'LAYER_OPACITY',
        senderId,
        layerId: msg.layerId,
        opacity: Math.max(0, Math.min(1, msg.opacity)),
      };
    }

    case 'LAYER_UPDATE': {
      if (typeof msg.layerId !== 'string' || !msg.layerId || msg.layerId.length > 256) return null;
      const patch = sanitizeWireLayerPatch(msg.patch);
      const clearedFields = sanitizeClearedFields(msg.clearedFields);
      if (Object.keys(patch).length === 0 && clearedFields.length === 0) return null;
      const lamport =
        typeof msg.lamport === 'number' && Number.isFinite(msg.lamport) ? msg.lamport : undefined;
      return {
        type: 'LAYER_UPDATE',
        senderId,
        layerId: msg.layerId,
        patch,
        clearedFields: clearedFields.length > 0 ? clearedFields : undefined,
        lamport,
      };
    }

    case 'LAYER_TREE_SYNC': {
      const layers = sanitizeWireLayerTree(msg.layers);
      if (!layers) return null;
      const lamport =
        typeof msg.lamport === 'number' && Number.isFinite(msg.lamport) ? msg.lamport : 0;
      const dirtyTileLayerIds = Array.isArray(msg.dirtyTileLayerIds)
        ? msg.dirtyTileLayerIds
            .filter((x): x is string => typeof x === 'string' && x.length > 0 && x.length <= 256)
            .slice(0, 512)
        : undefined;
      const removedLayerIds = Array.isArray(msg.removedLayerIds)
        ? msg.removedLayerIds
            .filter((x): x is string => typeof x === 'string' && x.length > 0 && x.length <= 256)
            .slice(0, 512)
        : undefined;
      return {
        type: 'LAYER_TREE_SYNC',
        senderId,
        layers,
        lamport,
        dirtyTileLayerIds,
        removedLayerIds,
      };
    }

    case 'PERSPECTIVE_RULER_SYNC': {
      const perspectiveRuler = sanitizePerspectiveRuler(msg.perspectiveRuler);
      if (perspectiveRuler === undefined) return null;
      const lamport =
        typeof msg.lamport === 'number' && Number.isFinite(msg.lamport) ? msg.lamport : undefined;
      return {
        type: 'PERSPECTIVE_RULER_SYNC',
        senderId,
        perspectiveRuler,
        lamport,
      };
    }

    case 'STRAIGHT_RULER_SYNC': {
      const straightRuler = sanitizeStraightRuler(msg.straightRuler);
      if (straightRuler === undefined) return null;
      const lamport =
        typeof msg.lamport === 'number' && Number.isFinite(msg.lamport) ? msg.lamport : undefined;
      return {
        type: 'STRAIGHT_RULER_SYNC',
        senderId,
        straightRuler,
        lamport,
      };
    }

    case 'ANIMATION_SYNC': {
      const animationTimeline = sanitizeAnimationTimeline(msg.animationTimeline);
      if (animationTimeline === undefined) return null;
      const lamport =
        typeof msg.lamport === 'number' && Number.isFinite(msg.lamport) ? msg.lamport : undefined;
      return {
        type: 'ANIMATION_SYNC',
        senderId,
        animationTimeline,
        lamport,
      };
    }

    case 'CANVAS_RESIZE': {
      const safe = sanitizeCanvasResize(msg);
      if (!safe) return null;
      const lamport =
        typeof msg.lamport === 'number' && Number.isFinite(msg.lamport) ? msg.lamport : undefined;
      return {
        type: 'CANVAS_RESIZE',
        senderId,
        dimensions: safe.dimensions,
        options: safe.options,
        lamport,
      };
    }

    case 'DOC_SYNC_RESPONSE': {
      const layers = sanitizeWireLayerTree(msg.layers);
      const d = msg.dimensions as Record<string, unknown> | undefined;
      if (!layers || !d || typeof d !== 'object') return null;
      if (
        typeof d.width !== 'number' ||
        !Number.isFinite(d.width) ||
        d.width < 1 ||
        d.width > MAX_SYNC_CANVAS_DIM ||
        typeof d.height !== 'number' ||
        !Number.isFinite(d.height) ||
        d.height < 1 ||
        d.height > MAX_SYNC_CANVAS_DIM
      ) {
        return null;
      }
      const width = Math.round(d.width);
      const height = Math.round(d.height);
      const dpi =
        typeof d.dpi === 'number' && Number.isFinite(d.dpi)
          ? Math.max(36, Math.min(2400, Math.round(d.dpi)))
          : undefined;
      const colorMode =
        msg.colorMode === 'color' || msg.colorMode === 'grayscale' || msg.colorMode === 'monochrome'
          ? msg.colorMode
          : 'color';

      const perspectiveRuler =
        msg.perspectiveRuler !== undefined
          ? sanitizePerspectiveRuler(msg.perspectiveRuler) ?? null
          : null;
      const straightRuler =
        msg.straightRuler !== undefined ? sanitizeStraightRuler(msg.straightRuler) ?? null : null;
      const animationTimeline =
        msg.animationTimeline !== undefined
          ? sanitizeAnimationTimeline(msg.animationTimeline) ?? null
          : null;

      return {
        type: 'DOC_SYNC_RESPONSE',
        senderId,
        targetPeerId: (msg.targetPeerId as string | number) ?? '',
        roomName: typeof msg.roomName === 'string' ? msg.roomName.slice(0, 128) : undefined,
        assignedLayerId:
          typeof msg.assignedLayerId === 'string' ? msg.assignedLayerId.slice(0, 256) : undefined,
        dimensions: { width, height, dpi },
        colorMode,
        layers,
        perspectiveRuler,
        straightRuler,
        animationTimeline,
      } as DocSyncResponseMessage;
    }

    case 'PEER_ROLE_UPDATE': {
      const targetPeerId =
        typeof msg.targetPeerId === 'string' || typeof msg.targetPeerId === 'number'
          ? String(msg.targetPeerId).trim().slice(0, 128)
          : '';
      if (!targetPeerId) return null;
      if (msg.role !== 'host' && msg.role !== 'editor' && msg.role !== 'viewer') return null;
      return {
        type: 'PEER_ROLE_UPDATE',
        senderId,
        targetPeerId,
        role: msg.role,
      };
    }

    case 'PEER_KICK':
    case 'PEER_BAN': {
      const targetPeerId =
        typeof msg.targetPeerId === 'string' || typeof msg.targetPeerId === 'number'
          ? String(msg.targetPeerId).trim().slice(0, 128)
          : '';
      if (!targetPeerId) return null;
      const reason =
        typeof msg.reason === 'string' && msg.reason.trim()
          ? msg.reason.trim().slice(0, 256)
          : undefined;
      return {
        type: msg.type,
        senderId,
        targetPeerId,
        ...(reason ? { reason } : {}),
      };
    }

    case 'PEER_UNBAN': {
      const targetPeerId =
        typeof msg.targetPeerId === 'string' || typeof msg.targetPeerId === 'number'
          ? String(msg.targetPeerId).trim().slice(0, 128)
          : '';
      if (!targetPeerId) return null;
      return {
        type: 'PEER_UNBAN',
        senderId,
        targetPeerId,
      };
    }

    case 'ACCESS_DENIED': {
      const allowedCodes = new Set<AccessDeniedCode>([
        'BANNED',
        'KICKED',
        'VIEWER_READONLY',
        'LAYER_LOCKED',
        'NOT_OWNER',
        'FORBIDDEN',
      ]);
      const code: AccessDeniedCode = allowedCodes.has(msg.code as AccessDeniedCode)
        ? (msg.code as AccessDeniedCode)
        : 'FORBIDDEN';
      const reason =
        typeof msg.reason === 'string' && msg.reason.trim()
          ? msg.reason.trim().slice(0, 256)
          : 'Action not permitted';
      const targetPeerId =
        typeof msg.targetPeerId === 'string' || typeof msg.targetPeerId === 'number'
          ? String(msg.targetPeerId).trim().slice(0, 128)
          : undefined;
      return {
        type: 'ACCESS_DENIED',
        senderId,
        ...(targetPeerId ? { targetPeerId } : {}),
        code,
        reason,
      };
    }

    default:
      return msg as unknown as MultiplayerMessage;
  }
}

export interface ConnectOptions {
  isReconnect?: boolean;
  sinceSeq?: number;
}

class MultiplayerService {
  private ws: WebSocket | null = null;
  private transport: ICollabTransport | null = null;
  private transportUnsubs: Array<() => void> = [];
  private messageHandlers: Set<MessageHandler> = new Set();
  private closeHandlers: Set<(reason?: string) => void> = new Set();
  private errorHandlers: Set<(err: Event | Error) => void> = new Set();
  private currentPeer: CollabPeer | null = null;
  private localRole: CollabRole = 'editor';

  // Lamport Logical Clock for Vector CRDT + authoritative server sequence tracking
  private lamportClock = 0;
  private lastServerSeq = 0;

  // Track already-broadcast brush asset hashes, tile versions, and tile delta batches
  private sentAssetHashes: Set<string> = new Set();
  private sentTileVersions: Map<string, number> = new Map();
  private sentDeltaBatches: WeakSet<TileDelta[]> = new WeakSet();

  // Throttling for cursor movement (max 60fps)
  private lastCursorSendTime = 0;
  private pendingCursor: { x: number; y: number; isDrawing: boolean; tool: ToolType } | null = null;
  private cursorThrottleRaf: number | null = null;

  // Trailing-edge throttles for high-frequency ruler / animation drag updates (~30Hz)
  private perspectiveThrottleTimer: ReturnType<typeof setTimeout> | null = null;
  private pendingPerspectiveRuler: PerspectiveRuler | null | undefined = undefined;
  private straightThrottleTimer: ReturnType<typeof setTimeout> | null = null;
  private pendingStraightRuler: StraightRuler | null | undefined = undefined;
  private animationThrottleTimer: ReturnType<typeof setTimeout> | null = null;
  private pendingAnimationTimeline: AnimationTimeline | null | undefined = undefined;

  public clearSentAssetHashes(): void {
    this.sentAssetHashes.clear();
  }

  public clearSyncDedupeCaches(): void {
    this.sentAssetHashes.clear();
    this.sentTileVersions.clear();
  }

  public getNextLamport(): number {
    return ++this.lamportClock;
  }

  public updateLamport(remoteLamport: number): void {
    this.lamportClock = Math.max(this.lamportClock, remoteLamport) + 1;
  }

  public getLastServerSeq(): number {
    return this.lastServerSeq;
  }

  public updateServerSeq(seq: number): void {
    if (Number.isSafeInteger(seq) && seq > this.lastServerSeq) {
      this.lastServerSeq = seq;
    }
  }

  public sendDocSyncRequest(sinceSeq?: number): void {
    if (!this.isConnected() || !this.currentPeer) return;
    this.sendMessage({
      type: 'DOC_SYNC_REQUEST',
      targetPeerId: this.currentPeer.id,
      ...(sinceSeq !== undefined && Number.isSafeInteger(sinceSeq) && sinceSeq >= 0
        ? { sinceSeq }
        : {}),
    });
  }

  public isConnected(): boolean {
    return (
      (this.ws !== null && this.ws.readyState === WebSocket.OPEN) ||
      (this.transport !== null && this.transport.isOpen())
    );
  }

  public getTransportKind(): CollabTransportKind | null {
    if (this.transport && this.transport.isOpen()) return this.transport.kind;
    if (this.ws && this.ws.readyState === WebSocket.OPEN) return 'ws';
    return null;
  }

  public getPeer(): CollabPeer | null {
    return this.currentPeer;
  }

  public setLocalRole(role: CollabRole): void {
    this.localRole = role;
    if (this.currentPeer) {
      this.currentPeer = {
        ...this.currentPeer,
        role,
        isHost: role === 'host',
      };
    }
  }

  public getLocalRole(): CollabRole {
    return this.localRole;
  }

  private canSendMutation(): boolean {
    return this.localRole !== 'viewer';
  }

  public getBufferedAmount(): number {
    if (this.transport) return this.transport.getBufferedAmount();
    return this.ws ? this.ws.bufferedAmount : 0;
  }

  private handleIncomingBinaryPayload(buf: ArrayBuffer): void {
    const parsed = this.decodeBinaryPacket(buf);
    if (!parsed) return;
    if (buf.byteLength >= 7) {
      const serverSeq = new DataView(buf).getUint32(3, true);
      if (serverSeq > 0) {
        parsed.seq = serverSeq;
        this.updateServerSeq(serverSeq);
      }
    }
    this.notifyHandlers(parsed);
  }

  private handleIncomingTextPayload(rawText: string): void {
    if (rawText.length > MAX_JSON_MESSAGE_CHARS) return;
    const raw = JSON.parse(rawText) as unknown;
    const sanitized = sanitizeIncomingJsonMessage(raw);
    if (!sanitized) return;
    if (typeof sanitized.seq === 'number') {
      this.updateServerSeq(sanitized.seq);
    }
    const remoteLamport = (sanitized as { lamport?: unknown }).lamport;
    if (typeof remoteLamport === 'number' && Number.isFinite(remoteLamport)) {
      this.updateLamport(remoteLamport);
    }
    this.notifyHandlers(sanitized);
  }

  private detachTransportQuietly(): void {
    for (const unsub of this.transportUnsubs) {
      try {
        unsub();
      } catch {
        // ignore
      }
    }
    this.transportUnsubs = [];
    if (this.transport) {
      const closing = this.transport;
      this.transport = null;
      try {
        closing.close();
      } catch {
        // ignore
      }
    }
  }

  private closeSocketQuietly(): void {
    this.detachTransportQuietly();
    if (!this.ws) return;
    const closingWs = this.ws;
    this.ws = null;
    try {
      closingWs.onopen = null;
      closingWs.onmessage = null;
      closingWs.onclose = null;
      closingWs.onerror = null;
      closingWs.close();
    } catch {
      // ignore close errors
    }
  }

  /**
   * Attaches a custom `ICollabTransport` (e.g., WebRtcHostHub or WebRtcGuestClient)
   * so the entire existing binary (`IN...`) & JSON protocol works identically over WebRTC.
   */
  public attachTransport(
    transport: ICollabTransport,
    peer: CollabPeer,
    options?: ConnectOptions & { sendJoinRequest?: boolean }
  ): void {
    const isReconnect = Boolean(options?.isReconnect);
    if (isReconnect) {
      this.closeSocketQuietly();
    } else {
      this.disconnect();
    }

    this.transport = transport;
    this.currentPeer = peer;
    this.localRole = peer.isHost ? 'host' : peer.role ?? (isReconnect ? this.localRole : 'editor');

    const unsubText = transport.onTextMessage((text) => {
      if (this.transport !== transport) return;
      try {
        this.handleIncomingTextPayload(text);
      } catch (err) {
        console.error('[Multiplayer] Failed to parse transport JSON:', err);
      }
    });

    const unsubBin = transport.onBinaryMessage((buf) => {
      if (this.transport !== transport) return;
      try {
        this.handleIncomingBinaryPayload(buf);
      } catch (err) {
        console.error('[Multiplayer] Failed to parse transport binary:', err);
      }
    });

    const unsubClose = transport.onClose((reason) => {
      if (this.transport === transport) {
        this.transport = null;
        this.transportUnsubs = [];
        this.closeHandlers.forEach((h) => h(reason));
      }
    });

    const unsubErr = transport.onError((err) => {
      if (this.transport !== transport) return;
      this.errorHandlers.forEach((h) => h(err));
    });

    this.transportUnsubs = [unsubText, unsubBin, unsubClose, unsubErr];

    const shouldSendJoin =
      options?.sendJoinRequest !== undefined
        ? options.sendJoinRequest
        : transport.kind === 'webrtc-guest';

    if (shouldSendJoin && transport.isOpen()) {
      const resumeSeq =
        isReconnect &&
        typeof options?.sinceSeq === 'number' &&
        Number.isSafeInteger(options.sinceSeq) &&
        options.sinceSeq >= 0
          ? options.sinceSeq
          : isReconnect
            ? this.lastServerSeq
            : undefined;

      this.sendMessage({
        type: 'JOIN_REQUEST',
        peer: this.currentPeer,
        ...(isReconnect ? { isReconnect: true } : {}),
        ...(resumeSeq !== undefined ? { sinceSeq: resumeSeq } : {}),
      });
    }
  }

  public connect(
    url: string,
    peer: CollabPeer,
    token?: string,
    options?: ConnectOptions
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      const isReconnect = Boolean(options?.isReconnect);
      if (isReconnect) {
        this.closeSocketQuietly();
      } else {
        this.disconnect();
      }
      this.currentPeer = peer;
      this.localRole = peer.isHost ? 'host' : peer.role ?? (isReconnect ? this.localRole : 'editor');

      const resumeSeq =
        isReconnect &&
        typeof options?.sinceSeq === 'number' &&
        Number.isSafeInteger(options.sinceSeq) &&
        options.sinceSeq >= 0
          ? options.sinceSeq
          : isReconnect
            ? this.lastServerSeq
            : undefined;

      let connectUrl = url;
      let displayUrl = url;
      try {
        const parsed = new URL(url);
        if (token && !parsed.searchParams.has('token')) {
          parsed.searchParams.set('token', token);
        }
        connectUrl = parsed.toString();
        parsed.searchParams.delete('token');
        displayUrl = parsed.toString();
      } catch {
        if (token && !/[?&]token=/.test(url)) {
          const sep = url.includes('?') ? '&' : '?';
          connectUrl = `${url}${sep}token=${encodeURIComponent(token)}`;
        }
      }

      let settled = false;
      const settleResolve = () => {
        if (settled) return;
        settled = true;
        if (timeoutId !== null) clearTimeout(timeoutId);
        resolve();
      };
      const settleReject = (err: Error) => {
        if (settled) return;
        settled = true;
        if (timeoutId !== null) clearTimeout(timeoutId);
        reject(err);
      };

      let timeoutId: ReturnType<typeof setTimeout> | null = null;

      try {
        const ws = new WebSocket(connectUrl);
        ws.binaryType = 'arraybuffer';
        this.ws = ws;

        timeoutId = setTimeout(() => {
          if (this.ws === ws && !settled) {
            try {
              ws.close();
            } catch {
              // ignore
            }
            this.ws = null;
            settleReject(new Error(`Connection timed out (${displayUrl})`));
          }
        }, WS_CONNECT_TIMEOUT_MS);

        ws.onopen = () => {
          if (this.ws !== ws) {
            ws.close();
            return;
          }
          // Send join handshake (carrying sinceSeq on reconnect for incremental op/tile catch-up)
          this.sendMessage({
            type: 'JOIN_REQUEST',
            peer: this.currentPeer!,
            ...(isReconnect ? { isReconnect: true } : {}),
            ...(resumeSeq !== undefined ? { sinceSeq: resumeSeq } : {}),
          });
          settleResolve();
        };

        ws.onmessage = async (event) => {
          if (this.ws !== ws) return;
          try {
            if (event.data instanceof ArrayBuffer || event.data instanceof Blob) {
              const buf =
                event.data instanceof ArrayBuffer
                  ? event.data
                  : await event.data.arrayBuffer();
              const parsed = this.decodeBinaryPacket(buf);
              if (parsed) {
                if (buf.byteLength >= 7) {
                  const serverSeq = new DataView(buf).getUint32(3, true);
                  if (serverSeq > 0) {
                    parsed.seq = serverSeq;
                    this.updateServerSeq(serverSeq);
                  }
                }
                this.notifyHandlers(parsed);
              }
            } else if (typeof event.data === 'string') {
              if (event.data.length > MAX_JSON_MESSAGE_CHARS) return;
              const raw = JSON.parse(event.data) as unknown;
              const sanitized = sanitizeIncomingJsonMessage(raw);
              if (sanitized) {
                if (typeof sanitized.seq === 'number') {
                  this.updateServerSeq(sanitized.seq);
                }
                const remoteLamport = (sanitized as { lamport?: unknown }).lamport;
                if (typeof remoteLamport === 'number' && Number.isFinite(remoteLamport)) {
                  this.updateLamport(remoteLamport);
                }
                this.notifyHandlers(sanitized);
              }
            }
          } catch (err) {
            console.error('[Multiplayer] Failed to parse message:', err, event.data);
          }
        };

        ws.onclose = (ev) => {
          if (this.ws === ws) {
            this.ws = null;
          }
          if (!settled) {
            const detail = ev.reason ? `: ${ev.reason}` : '';
            settleReject(new Error(`Failed to connect to socket server (${displayUrl})${detail}`));
          } else {
            this.closeHandlers.forEach((h) => h());
          }
        };

        ws.onerror = (err) => {
          if (this.ws !== ws) return;
          this.errorHandlers.forEach((h) => h(err));
          settleReject(new Error(`Failed to connect to socket server (${displayUrl})`));
        };
      } catch (err: any) {
        settleReject(new Error(err?.message || `WebSocket initialization error (${displayUrl})`));
      }
    });
  }

  public disconnect() {
    if (this.transport) {
      if (
        this.currentPeer &&
        this.transport.isOpen() &&
        this.transport.kind !== 'webrtc-host'
      ) {
        this.sendMessage({
          type: 'PEER_LEFT',
          peerId: this.currentPeer.id,
        });
      }
      this.detachTransportQuietly();
    }
    if (this.ws) {
      const closingWs = this.ws;
      if (this.currentPeer && closingWs.readyState === WebSocket.OPEN) {
        this.sendMessage({
          type: 'PEER_LEFT',
          peerId: this.currentPeer.id,
        });
      }
      this.ws = null;
      try {
        closingWs.onopen = null;
        closingWs.onmessage = null;
        closingWs.onclose = null;
        closingWs.onerror = null;
        closingWs.close();
      } catch {
        // ignore close errors
      }
    }
    this.currentPeer = null;
    this.localRole = 'editor';
    this.lastServerSeq = 0;
    this.sentAssetHashes.clear();
    this.sentTileVersions.clear();
    if (this.cursorThrottleRaf) {
      cancelAnimationFrame(this.cursorThrottleRaf);
      this.cursorThrottleRaf = null;
    }
    if (this.perspectiveThrottleTimer) {
      clearTimeout(this.perspectiveThrottleTimer);
      this.perspectiveThrottleTimer = null;
    }
    this.pendingPerspectiveRuler = undefined;
    if (this.straightThrottleTimer) {
      clearTimeout(this.straightThrottleTimer);
      this.straightThrottleTimer = null;
    }
    this.pendingStraightRuler = undefined;
    if (this.animationThrottleTimer) {
      clearTimeout(this.animationThrottleTimer);
      this.animationThrottleTimer = null;
    }
    this.pendingAnimationTimeline = undefined;
  }

  public onMessage(handler: MessageHandler): () => void {
    this.messageHandlers.add(handler);
    return () => this.messageHandlers.delete(handler);
  }

  public onClose(handler: (reason?: string) => void): () => void {
    this.closeHandlers.add(handler);
    return () => this.closeHandlers.delete(handler);
  }

  public onError(handler: (err: Event | Error) => void): () => void {
    this.errorHandlers.add(handler);
    return () => this.errorHandlers.delete(handler);
  }

  public sendMessage(msg: MultiplayerMessage) {
    if (this.transport && this.transport.isOpen()) {
      if (!msg.senderId && this.currentPeer) {
        msg.senderId = this.currentPeer.id;
      }
      this.transport.sendText(JSON.stringify(msg));
      return;
    }
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      if (!msg.senderId && this.currentPeer) {
        msg.senderId = this.currentPeer.id;
      }
      this.ws.send(JSON.stringify(msg));
    }
  }

  public sendBinary(buffer: ArrayBuffer | Uint8Array, targetPeerId?: string | number) {
    if (this.transport && this.transport.isOpen()) {
      if (targetPeerId !== undefined && this.transport.sendBinaryTo) {
        this.transport.sendBinaryTo(targetPeerId, buffer);
        return;
      }
      this.transport.sendBinary(buffer);
      return;
    }
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(buffer as any);
    }
  }

  private notifyHandlers(msg: MultiplayerMessage) {
    this.messageHandlers.forEach((handler) => handler(msg));
  }

  // --- Binary Packet Encoding & Decoding ---

  public decodeBinaryPacket(buf: ArrayBuffer): MultiplayerMessage | null {
    if (buf.byteLength < 11 || buf.byteLength > MAX_BINARY_PACKET_BYTES) return null;
    const view = new DataView(buf);

    // Verify magic
    if (view.getUint8(0) !== BINARY_MAGIC_0 || view.getUint8(1) !== BINARY_MAGIC_1) {
      return null;
    }

    const code = view.getUint8(2);
    const lamport = view.getUint32(3, true);
    this.updateLamport(lamport);

    const payloadLen = view.getUint32(7, true);
    if (payloadLen > MAX_BINARY_PACKET_BYTES || 11 + payloadLen > buf.byteLength) return null;
    const payloadBytes = new Uint8Array(buf, 11, payloadLen);
    const decoder = new TextDecoder();

    switch (code) {
      case CODE_STROKE_START: {
        const jsonStr = decoder.decode(payloadBytes);
        const data = JSON.parse(jsonStr);
        const safeSettings = sanitizeRemoteBrushSettings(data?.brushSettings);
        if (!safeSettings || !isValidRemotePoint(data?.startPoint)) return null;
        return {
          type: 'STROKE_START',
          senderId: data.peerId,
          strokeId: String(data.strokeId || '').slice(0, 128),
          peerId: data.peerId,
          peerName: String(data.peerName || 'Peer').slice(0, 64),
          peerColor: String(data.peerColor || '#38bdf8').slice(0, 32),
          layerId: String(data.layerId || '').slice(0, 256),
          brushSettings: safeSettings,
          brushAssetRefs: sanitizeBrushAssetRefs(data.brushAssetRefs),
          tool: TOOL_TYPES_LIST.includes(data.tool) ? data.tool : 'brush',
          startPoint: {
            ...data.startPoint,
            pressure: Number.isFinite(data.startPoint.pressure)
              ? Math.max(0, Math.min(1, data.startPoint.pressure))
              : 0.5,
            width: Number.isFinite(data.startPoint.width)
              ? Math.max(0.1, Math.min(2000, data.startPoint.width))
              : safeSettings.size,
          },
        } as StrokeStartMessage;
      }

      case CODE_STROKE_CHUNK: {
        // Format: [strokeIdLen: u16, strokeId, peerIdLen: u16, peerId, pointCount: u16, points (20B each)...]
        let offset = 0;
        if (payloadBytes.byteLength < 6) return null;
        const pView = new DataView(payloadBytes.buffer, payloadBytes.byteOffset, payloadBytes.byteLength);

        const sIdLen = pView.getUint16(offset, true);
        offset += 2;
        if (sIdLen > 256 || offset + sIdLen + 4 > payloadBytes.byteLength) return null;
        const strokeId = decoder.decode(payloadBytes.subarray(offset, offset + sIdLen));
        offset += sIdLen;

        const pIdLen = pView.getUint16(offset, true);
        offset += 2;
        if (pIdLen > 256 || offset + pIdLen + 2 > payloadBytes.byteLength) return null;
        const peerId = decoder.decode(payloadBytes.subarray(offset, offset + pIdLen));
        offset += pIdLen;

        const pointCount = pView.getUint16(offset, true);
        offset += 2;
        if (
          pointCount > MAX_STROKE_CHUNK_POINTS ||
          offset + pointCount * STROKE_CHUNK_POINT_STRIDE > payloadBytes.byteLength
        ) {
          return null;
        }

        const points: Point[] = [];
        for (let i = 0; i < pointCount; i++) {
          const x = pView.getFloat32(offset, true);
          const y = pView.getFloat32(offset + 4, true);
          const pressure = pView.getFloat32(offset + 8, true);
          const width = pView.getFloat32(offset + 12, true);
          const tiltX = pView.getInt8(offset + 16);
          const tiltY = pView.getInt8(offset + 17);
          const twist = (pView.getUint8(offset + 18) * 360) / 255;
          const flags = pView.getUint8(offset + 19);
          offset += STROKE_CHUNK_POINT_STRIDE;
          if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
          points.push({
            x,
            y,
            pressure: Number.isFinite(pressure) ? Math.max(0, Math.min(1, pressure)) : 0.5,
            width: Number.isFinite(width) ? Math.max(0.1, Math.min(2000, width)) : 1,
            tiltX,
            tiltY,
            twist,
            isCorner: (flags & 1) !== 0,
          });
        }

        if (points.length === 0) return null;

        return {
          type: 'STROKE_CHUNK',
          senderId: peerId,
          strokeId,
          peerId,
          points,
        } as StrokeChunkMessage;
      }

      case CODE_STROKE_FINISH: {
        const jsonStr = decoder.decode(payloadBytes);
        const data = JSON.parse(jsonStr);
        return {
          type: 'STROKE_FINISH',
          senderId: data.peerId,
          strokeId: String(data.strokeId || '').slice(0, 128),
          peerId: data.peerId,
          layerId: String(data.layerId || '').slice(0, 256),
          endPoint: data.endPoint,
          dirtyRect: data.dirtyRect,
          vectorStroke: data.vectorStroke,
        } as StrokeFinishMessage;
      }

      case CODE_TILE_DELTA: {
        // Format: [layerIdLen: u16, layerId, lz4SerializedTileBuffer...]
        let offset = 0;
        if (payloadBytes.byteLength < 2) return null;
        const pView = new DataView(payloadBytes.buffer, payloadBytes.byteOffset, payloadBytes.byteLength);
        const layerIdLen = pView.getUint16(offset, true);
        offset += 2;
        if (layerIdLen === 0 || layerIdLen > 256 || offset + layerIdLen > payloadBytes.byteLength) {
          return null;
        }
        const layerId = decoder.decode(payloadBytes.subarray(offset, offset + layerIdLen));
        offset += layerIdLen;

        const tilePacket = payloadBytes.subarray(offset);
        const tile = deserializeTileBufferStrict(layerId, tilePacket);
        if (
          !tile ||
          tile.tileX < 0 ||
          tile.tileY < 0 ||
          tile.tileX >= MAX_TILE_COORD ||
          tile.tileY >= MAX_TILE_COORD
        ) {
          return null;
        }

        return {
          type: 'BINARY_TILE',
          layerId,
          tileX: tile.tileX,
          tileY: tile.tileY,
          format: tile.format,
          version: tile.version,
          data: tile.data,
        } as TileStreamMessage;
      }

      case CODE_BRUSH_ASSET_DATA: {
        // Format: [hashLen: u8, hashUtf8, mimeLen: u8, mimeUtf8, rawBytes...]
        if (payloadBytes.byteLength < 4) return null;
        let offset = 0;
        const hashLen = payloadBytes[offset++];
        if (hashLen === 0 || hashLen > 64 || offset + hashLen + 1 > payloadBytes.byteLength) {
          return null;
        }
        const hash = decoder.decode(payloadBytes.subarray(offset, offset + hashLen));
        offset += hashLen;

        const mimeLen = payloadBytes[offset++];
        if (mimeLen === 0 || mimeLen > 64 || offset + mimeLen > payloadBytes.byteLength) {
          return null;
        }
        const mime = decoder.decode(payloadBytes.subarray(offset, offset + mimeLen));
        offset += mimeLen;

        const rawLen = payloadBytes.byteLength - offset;
        if (
          !isValidBrushAssetHash(hash) ||
          !isAllowedBrushAssetMime(mime) ||
          rawLen === 0 ||
          rawLen > MAX_BRUSH_ASSET_BYTES
        ) {
          return null;
        }

        const data = new Uint8Array(rawLen);
        data.set(payloadBytes.subarray(offset));
        return {
          type: 'BRUSH_ASSET_DATA',
          hash,
          mime,
          data,
        } as BrushAssetDataMessage;
      }

      case CODE_BRUSH_ASSET_REQUEST: {
        const jsonStr = decoder.decode(payloadBytes);
        const data = JSON.parse(jsonStr);
        if (!isValidBrushAssetHash(data?.hash)) return null;
        return {
          type: 'BRUSH_ASSET_REQUEST',
          hash: data.hash,
          targetPeerId: data.targetPeerId,
        } as BrushAssetRequestMessage;
      }

      case CODE_CURSOR_MOVE: {
        if (payloadBytes.byteLength < 12) return null;
        const pView = new DataView(payloadBytes.buffer, payloadBytes.byteOffset, payloadBytes.byteLength);
        let offset = 0;
        const pIdLen = pView.getUint16(offset, true);
        offset += 2;
        if (offset + pIdLen + 10 > payloadBytes.byteLength) return null;
        const peerId = decoder.decode(payloadBytes.subarray(offset, offset + pIdLen));
        offset += pIdLen;

        const x = pView.getFloat32(offset, true);
        const y = pView.getFloat32(offset + 4, true);
        if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
        const isDrawing = pView.getUint8(offset + 8) === 1;
        const toolCode = pView.getUint8(offset + 9);
        const tool: ToolType = TOOL_TYPES_LIST[toolCode] || 'brush';

        return {
          type: 'CURSOR_MOVE',
          senderId: peerId,
          peerId,
          x,
          y,
          isDrawing,
          tool,
        } as CursorMoveMessage;
      }

      case CODE_SELECTIVE_UNDO: {
        const jsonStr = decoder.decode(payloadBytes);
        const data = JSON.parse(jsonStr);
        return {
          type: 'SELECTIVE_UNDO',
          senderId: data.peerId,
          strokeId: data.strokeId,
          peerId: data.peerId,
          lamport: data.lamport,
        } as SelectiveUndoMessage;
      }

      case CODE_LAYER_MASK_DATA: {
        // Format: [layerIdLen: u16, layerId, flags: u8, x: u32, y: u32, width: u32, height: u32, body...]
        if (payloadBytes.byteLength < 19) return null;
        const pView = new DataView(payloadBytes.buffer, payloadBytes.byteOffset, payloadBytes.byteLength);
        let offset = 0;
        const layerIdLen = pView.getUint16(offset, true);
        offset += 2;
        if (layerIdLen === 0 || layerIdLen > 256 || offset + layerIdLen + 17 > payloadBytes.byteLength) {
          return null;
        }
        const layerId = decoder.decode(payloadBytes.subarray(offset, offset + layerIdLen));
        offset += layerIdLen;

        const flags = payloadBytes[offset++];
        const x = pView.getUint32(offset, true);
        const y = pView.getUint32(offset + 4, true);
        const width = pView.getUint32(offset + 8, true);
        const height = pView.getUint32(offset + 12, true);
        offset += 16;

        if (
          x > MAX_SYNC_CANVAS_DIM ||
          y > MAX_SYNC_CANVAS_DIM ||
          width === 0 ||
          height === 0 ||
          width > MAX_SYNC_CANVAS_DIM ||
          height > MAX_SYNC_CANVAS_DIM
        ) {
          return null;
        }

        const isFullReplace = (flags & MASK_FLAG_FULL_REPLACE) !== 0;
        const isCompressed = (flags & MASK_FLAG_LZ4) !== 0;
        const isSolidFill = (flags & MASK_FLAG_SOLID_FILL) !== 0;
        const body = payloadBytes.subarray(offset);

        if (isSolidFill) {
          if (body.byteLength !== 1) return null;
          return {
            type: 'BINARY_MASK',
            layerId,
            x,
            y,
            width,
            height,
            isFullReplace,
            solidFill: body[0],
            data: null,
          } as LayerMaskDataMessage;
        }

        const expectedPixels = width * height;
        if (expectedPixels <= 0 || expectedPixels > MAX_MASK_DECODE_BYTES) return null;

        let data: Uint8Array | null;
        if (isCompressed) {
          data = lz4DecompressBlock(body, expectedPixels, MAX_MASK_DECODE_BYTES);
          if (!data) return null;
        } else {
          if (body.byteLength !== expectedPixels) return null;
          data = new Uint8Array(expectedPixels);
          data.set(body);
        }

        return {
          type: 'BINARY_MASK',
          layerId,
          x,
          y,
          width,
          height,
          isFullReplace,
          data,
        } as LayerMaskDataMessage;
      }

      default:
        return null;
    }
  }

  // --- Drawing Events via Compact Binary Packets ---

  public sendBrushAssetData(hash: string, mime: string, bytes: Uint8Array) {
    if (!this.isConnected()) return;
    if (!isValidBrushAssetHash(hash) || !isAllowedBrushAssetMime(mime)) return;
    if (bytes.byteLength === 0 || bytes.byteLength > MAX_BRUSH_ASSET_BYTES) return;

    const encoder = new TextEncoder();
    const hashBytes = encoder.encode(hash);
    const mimeBytes = encoder.encode(mime);
    const payloadSize = 1 + hashBytes.length + 1 + mimeBytes.length + bytes.byteLength;
    const packet = new Uint8Array(11 + payloadSize);
    const view = new DataView(packet.buffer);

    view.setUint8(0, BINARY_MAGIC_0);
    view.setUint8(1, BINARY_MAGIC_1);
    view.setUint8(2, CODE_BRUSH_ASSET_DATA);
    view.setUint32(3, this.getNextLamport(), true);
    view.setUint32(7, payloadSize, true);

    let offset = 11;
    packet[offset++] = hashBytes.length;
    packet.set(hashBytes, offset);
    offset += hashBytes.length;
    packet[offset++] = mimeBytes.length;
    packet.set(mimeBytes, offset);
    offset += mimeBytes.length;
    packet.set(bytes, offset);

    this.sendBinary(packet);
  }

  public sendBrushAssetRequest(hash: string, targetPeerId?: string | number) {
    if (!this.isConnected() || !isValidBrushAssetHash(hash)) return;

    const encoder = new TextEncoder();
    const payloadBytes = encoder.encode(JSON.stringify({ hash, targetPeerId }));
    const packet = new Uint8Array(11 + payloadBytes.length);
    const view = new DataView(packet.buffer);
    view.setUint8(0, BINARY_MAGIC_0);
    view.setUint8(1, BINARY_MAGIC_1);
    view.setUint8(2, CODE_BRUSH_ASSET_REQUEST);
    view.setUint32(3, this.getNextLamport(), true);
    view.setUint32(7, payloadBytes.length, true);
    packet.set(payloadBytes, 11);

    this.sendBinary(packet);
  }

  public sendStrokeStart(
    strokeId: string,
    layerId: string,
    brushSettings: BrushSettings,
    tool: ToolType,
    startPoint: Point
  ) {
    if (!this.isConnected() || !this.currentPeer || !this.canSendMutation()) return;

    const { wireSettings, assetRefs, assets } = prepareBrushSettingsForWire(brushSettings);
    for (let i = 0; i < assets.length; i++) {
      const asset = assets[i];
      if (!this.sentAssetHashes.has(asset.hash)) {
        this.sendBrushAssetData(asset.hash, asset.mime, asset.bytes);
        this.sentAssetHashes.add(asset.hash);
      }
    }

    const encoder = new TextEncoder();
    const payloadStr = JSON.stringify({
      strokeId,
      peerId: this.currentPeer.id,
      peerName: this.currentPeer.name,
      peerColor: this.currentPeer.color,
      layerId,
      brushSettings: wireSettings,
      brushAssetRefs: assetRefs,
      tool,
      startPoint,
    });
    const payloadBytes = encoder.encode(payloadStr);

    const header = new Uint8Array(11 + payloadBytes.length);
    const view = new DataView(header.buffer);
    view.setUint8(0, BINARY_MAGIC_0);
    view.setUint8(1, BINARY_MAGIC_1);
    view.setUint8(2, CODE_STROKE_START);
    view.setUint32(3, this.getNextLamport(), true);
    view.setUint32(7, payloadBytes.length, true);
    header.set(payloadBytes, 11);

    this.sendBinary(header);
  }

  public sendStrokeChunk(strokeId: string, points: Point[]) {
    if (!this.isConnected() || !this.currentPeer || !this.canSendMutation() || points.length === 0) return;

    const MAX_POINTS_PER_PACKET = 4096;
    if (points.length > MAX_POINTS_PER_PACKET) {
      for (let start = 0; start < points.length; start += MAX_POINTS_PER_PACKET) {
        this.sendStrokeChunk(strokeId, points.slice(start, start + MAX_POINTS_PER_PACKET));
      }
      return;
    }

    const encoder = new TextEncoder();
    const strokeIdBytes = encoder.encode(strokeId);
    const peerIdBytes = encoder.encode(String(this.currentPeer.id));

    const payloadSize =
      6 + strokeIdBytes.length + peerIdBytes.length + points.length * STROKE_CHUNK_POINT_STRIDE;
    const packet = new Uint8Array(11 + payloadSize);
    const view = new DataView(packet.buffer);

    view.setUint8(0, BINARY_MAGIC_0);
    view.setUint8(1, BINARY_MAGIC_1);
    view.setUint8(2, CODE_STROKE_CHUNK);
    view.setUint32(3, this.getNextLamport(), true);
    view.setUint32(7, payloadSize, true);

    let offset = 11;
    view.setUint16(offset, strokeIdBytes.length, true);
    offset += 2;
    packet.set(strokeIdBytes, offset);
    offset += strokeIdBytes.length;

    view.setUint16(offset, peerIdBytes.length, true);
    offset += 2;
    packet.set(peerIdBytes, offset);
    offset += peerIdBytes.length;

    view.setUint16(offset, points.length, true);
    offset += 2;

    for (let i = 0; i < points.length; i++) {
      const pt = points[i];
      view.setFloat32(offset, pt.x, true);
      view.setFloat32(offset + 4, pt.y, true);
      view.setFloat32(offset + 8, pt.pressure, true);
      view.setFloat32(offset + 12, pt.width, true);
      const tx = Math.max(-90, Math.min(90, Math.round(pt.tiltX ?? 0)));
      const ty = Math.max(-90, Math.min(90, Math.round(pt.tiltY ?? 0)));
      const tw = Math.max(0, Math.min(255, Math.round((((pt.twist ?? 0) % 360 + 360) % 360) * (255 / 360))));
      view.setInt8(offset + 16, tx);
      view.setInt8(offset + 17, ty);
      view.setUint8(offset + 18, tw);
      view.setUint8(offset + 19, pt.isCorner ? 1 : 0);
      offset += STROKE_CHUNK_POINT_STRIDE;
    }

    this.sendBinary(packet);
  }

  public sendStrokeFinish(
    strokeId: string,
    layerId: string,
    endPoint: Point,
    dirtyRect?: DirtyRect,
    vectorStroke?: VectorStroke
  ) {
    if (!this.isConnected() || !this.currentPeer || !this.canSendMutation()) return;

    const encoder = new TextEncoder();
    const payloadStr = JSON.stringify({
      strokeId,
      peerId: this.currentPeer.id,
      layerId,
      endPoint,
      dirtyRect,
      vectorStroke,
    });
    const payloadBytes = encoder.encode(payloadStr);

    const header = new Uint8Array(11 + payloadBytes.length);
    const view = new DataView(header.buffer);
    view.setUint8(0, BINARY_MAGIC_0);
    view.setUint8(1, BINARY_MAGIC_1);
    view.setUint8(2, CODE_STROKE_FINISH);
    view.setUint32(3, this.getNextLamport(), true);
    view.setUint32(7, payloadBytes.length, true);
    header.set(payloadBytes, 11);

    this.sendBinary(header);
  }

  /**
   * Stream a single LZ4-compressed binary tile (or 14-byte deletion tombstone when tile.data === null).
   */
  public sendTileDelta(layerId: string, tile: TileBuffer, targetPeerId?: string | number) {
    if (!this.isConnected() || !this.canSendMutation()) return;

    const tileKey = `${layerId}:${tile.tileX}:${tile.tileY}`;
    if (targetPeerId === undefined) {
      if (tile.data === null) {
        this.sentTileVersions.delete(tileKey);
      } else if (tile.version > 0) {
        this.sentTileVersions.set(tileKey, tile.version);
      }
    }

    const encoder = new TextEncoder();
    const layerIdBytes = encoder.encode(layerId);
    const tileBytes = serializeTileBuffer(tile);

    const payloadSize = 2 + layerIdBytes.length + tileBytes.length;
    const packet = new Uint8Array(11 + payloadSize);
    const view = new DataView(packet.buffer);

    view.setUint8(0, BINARY_MAGIC_0);
    view.setUint8(1, BINARY_MAGIC_1);
    view.setUint8(2, CODE_TILE_DELTA);
    view.setUint32(3, this.getNextLamport(), true);
    view.setUint32(7, payloadSize, true);

    let offset = 11;
    view.setUint16(offset, layerIdBytes.length, true);
    offset += 2;
    packet.set(layerIdBytes, offset);
    offset += layerIdBytes.length;

    packet.set(tileBytes, offset);
    this.sendBinary(packet, targetPeerId);
  }

  /**
   * Broadcast authoritative LZ4-compressed BINARY_TILE packets for all tiles touched
   * by a raster operation (stroke, fill, transform, liquify, filter, tonal, undo/redo).
   * Idempotent per TileDelta[] reference unless options.force is set.
   */
  public sendTileDeltas(
    deltas: TileDelta[],
    grid: SparseTileGrid,
    options?: { force?: boolean }
  ): void {
    if (!this.isConnected() || !this.canSendMutation() || !deltas || deltas.length === 0) return;
    if (!options?.force && this.sentDeltaBatches.has(deltas)) return;
    this.sentDeltaBatches.add(deltas);

    const seenKeys = new Set<string>();
    const queue: Array<{ layerId: string; tile: TileBuffer }> = [];

    for (let i = 0; i < deltas.length; i++) {
      const delta = deltas[i];
      if (seenKeys.has(delta.key)) continue;
      seenKeys.add(delta.key);

      const { layerId, tileX, tileY } = parseTileKey(delta.key);
      const tile = grid.getTile(layerId, tileX, tileY, 0);
      if (tile && tile.data) {
        queue.push({ layerId, tile });
      } else {
        queue.push({
          layerId,
          tile: {
            layerId,
            tileX,
            tileY,
            format: delta.format,
            data: null,
            dirty: true,
            version: 0,
            isPagedToDisk: false,
            lastAccessTimestamp: 0,
            lod: 0,
          },
        });
      }
    }

    this.streamTileQueuePaced(queue);
  }

  /**
   * Stream all populated LOD 0 tiles of a layer as LZ4-compressed BINARY_TILE packets.
   * Deduplicates unchanged tile versions unless options.force is true.
   */
  public streamLayerTiles(
    layerId: string,
    grid: SparseTileGrid,
    options?: { force?: boolean }
  ): void {
    if (!this.isConnected() || !this.canSendMutation()) return;
    const tiles = grid.getLayerTiles(layerId);
    if (tiles.length === 0) return;

    const force = Boolean(options?.force);
    const queue: Array<{ layerId: string; tile: TileBuffer }> = [];
    for (let i = 0; i < tiles.length; i++) {
      const t = tiles[i];
      if (!t.data || t.data.byteLength === 0) continue;
      if (!force && t.version > 0) {
        const key = `${layerId}:${t.tileX}:${t.tileY}`;
        if (this.sentTileVersions.get(key) === t.version) continue;
      }
      queue.push({ layerId, tile: t });
    }
    this.streamTileQueuePaced(queue);
  }

  private streamTileQueuePaced(queue: Array<{ layerId: string; tile: TileBuffer }>): void {
    if (queue.length === 0 || !this.isConnected()) return;

    const MAX_BUFFERED_BYTES = 2 * 1024 * 1024;
    // Small operations (typical strokes) flush synchronously before STROKE_FINISH for zero flicker
    if (queue.length <= 32 && this.getBufferedAmount() <= MAX_BUFFERED_BYTES) {
      for (let i = 0; i < queue.length; i++) {
        this.sendTileDelta(queue[i].layerId, queue[i].tile);
      }
      return;
    }

    let idx = 0;
    const BATCH_SIZE = 16;
    const pump = () => {
      if (!this.isConnected()) return;
      if (this.getBufferedAmount() > MAX_BUFFERED_BYTES) {
        setTimeout(pump, 20);
        return;
      }
      const end = Math.min(idx + BATCH_SIZE, queue.length);
      for (; idx < end; idx++) {
        this.sendTileDelta(queue[idx].layerId, queue[idx].tile);
      }
      if (idx < queue.length) {
        setTimeout(pump, 4);
      }
    };

    pump();
  }

  /**
   * Broadcast a selective collaborative undo command (undoing a stroke without reverting peer strokes).
   */
  public sendSelectiveUndo(strokeId: string) {
    if (!this.isConnected() || !this.currentPeer || !this.canSendMutation()) return;

    const encoder = new TextEncoder();
    const payloadStr = JSON.stringify({
      strokeId,
      peerId: this.currentPeer.id,
      lamport: this.getNextLamport(),
    });
    const payloadBytes = encoder.encode(payloadStr);

    const packet = new Uint8Array(11 + payloadBytes.length);
    const view = new DataView(packet.buffer);
    view.setUint8(0, BINARY_MAGIC_0);
    view.setUint8(1, BINARY_MAGIC_1);
    view.setUint8(2, CODE_SELECTIVE_UNDO);
    view.setUint32(3, this.lamportClock, true);
    view.setUint32(7, payloadBytes.length, true);
    packet.set(payloadBytes, 11);

    this.sendBinary(packet);
  }

  // --- Real-time Cursor Throttling (30-60 Hz) ---

  public sendCursor(x: number, y: number, isDrawing: boolean, tool: ToolType) {
    if (!this.isConnected() || !this.currentPeer) return;

    this.pendingCursor = { x, y, isDrawing, tool };
    const now = performance.now();

    if (now - this.lastCursorSendTime >= 24) {
      this.flushCursor();
    } else if (this.cursorThrottleRaf === null) {
      this.cursorThrottleRaf = requestAnimationFrame(() => {
        this.cursorThrottleRaf = null;
        this.flushCursor();
      });
    }
  }

  private flushCursor() {
    if (!this.pendingCursor || !this.currentPeer || !this.isConnected()) return;

    this.lastCursorSendTime = performance.now();
    const encoder = new TextEncoder();
    const peerIdBytes = encoder.encode(String(this.currentPeer.id));

    const payloadSize = 2 + peerIdBytes.length + 10;
    const packet = new Uint8Array(11 + payloadSize);
    const view = new DataView(packet.buffer);

    view.setUint8(0, BINARY_MAGIC_0);
    view.setUint8(1, BINARY_MAGIC_1);
    view.setUint8(2, CODE_CURSOR_MOVE);
    view.setUint32(3, this.getNextLamport(), true);
    view.setUint32(7, payloadSize, true);

    let offset = 11;
    view.setUint16(offset, peerIdBytes.length, true);
    offset += 2;
    packet.set(peerIdBytes, offset);
    offset += peerIdBytes.length;

    const toolIdx = Math.max(0, TOOL_TYPES_LIST.indexOf(this.pendingCursor.tool));
    view.setFloat32(offset, this.pendingCursor.x, true);
    view.setFloat32(offset + 4, this.pendingCursor.y, true);
    view.setUint8(offset + 8, this.pendingCursor.isDrawing ? 1 : 0);
    view.setUint8(offset + 9, toolIdx);

    this.sendBinary(packet);
    this.pendingCursor = null;
  }

  // --- Layer & Document State Synchronization ---

  public sendLayerAdd(layerItem: LayerItem | WireLayerItem, insertIndex?: number) {
    if (!this.isConnected() || !this.canSendMutation()) return;
    const wireLayer = serializeLayerForWire(layerItem as LayerItem);
    const msg: LayerActionMessage = {
      type: 'LAYER_ADD',
      layerId: wireLayer.id,
      layerItem: wireLayer,
      ...(insertIndex !== undefined ? { insertIndex } : {}),
    };
    this.sendMessage(msg);
  }

  public sendLayerDelete(layerId: string) {
    if (!this.isConnected() || !this.canSendMutation()) return;
    const msg: LayerActionMessage = {
      type: 'LAYER_DELETE',
      layerId,
    };
    this.sendMessage(msg);
  }

  public sendLayerClear(layerId: string) {
    if (!this.isConnected() || !this.canSendMutation()) return;
    const msg: LayerActionMessage = {
      type: 'LAYER_CLEAR',
      layerId,
    };
    this.sendMessage(msg);
  }

  public sendLayerRename(layerId: string, newName: string) {
    if (!this.isConnected() || !this.canSendMutation()) return;
    const msg: LayerActionMessage = {
      type: 'LAYER_RENAME',
      layerId,
      newName,
    };
    this.sendMessage(msg);
  }

  public sendLayerVisibility(layerId: string, visible: boolean) {
    if (!this.isConnected() || !this.canSendMutation()) return;
    const msg: LayerActionMessage = {
      type: 'LAYER_VISIBILITY',
      layerId,
      visible,
    };
    this.sendMessage(msg);
  }

  public sendLayerOpacity(layerId: string, opacity: number) {
    if (!this.isConnected() || !this.canSendMutation()) return;
    const msg: LayerActionMessage = {
      type: 'LAYER_OPACITY',
      layerId,
      opacity,
    };
    this.sendMessage(msg);
  }

  public sendLayerUpdate(
    layerId: string,
    patch: Partial<WireLayerItem>,
    clearedFields?: LayerClearableField[]
  ) {
    if (!this.isConnected() || !this.canSendMutation() || !layerId) return;
    const safePatch = sanitizeWireLayerPatch(patch);
    const safeCleared = clearedFields && clearedFields.length > 0 ? sanitizeClearedFields(clearedFields) : [];
    if (Object.keys(safePatch).length === 0 && safeCleared.length === 0) return;

    const msg: LayerUpdateMessage = {
      type: 'LAYER_UPDATE',
      layerId,
      patch: safePatch,
      ...(safeCleared.length > 0 ? { clearedFields: safeCleared } : {}),
      lamport: this.getNextLamport(),
    };
    this.sendMessage(msg);
  }

  public sendLayerTreeSync(
    layers: Array<LayerItem | WireLayerItem>,
    options?: { dirtyTileLayerIds?: string[]; removedLayerIds?: string[] }
  ) {
    if (!this.isConnected() || !this.canSendMutation() || layers.length === 0) return;
    const wireLayers = layers.map((l) => serializeLayerForWire(l as LayerItem));
    const msg: LayerTreeSyncMessage = {
      type: 'LAYER_TREE_SYNC',
      layers: wireLayers,
      lamport: this.getNextLamport(),
      ...(options?.dirtyTileLayerIds && options.dirtyTileLayerIds.length > 0
        ? { dirtyTileLayerIds: options.dirtyTileLayerIds }
        : {}),
      ...(options?.removedLayerIds && options.removedLayerIds.length > 0
        ? { removedLayerIds: options.removedLayerIds }
        : {}),
    };
    this.sendMessage(msg);
  }

  // --- Binary Layer Mask Synchronization (LZ4 / 1-byte solid fill, auto-chunked <= 1024x1024) ---

  private sendMaskPacket(
    layerId: string,
    x: number,
    y: number,
    width: number,
    height: number,
    isFullReplace: boolean,
    solidValue: number | null,
    pixels: Uint8Array | null,
    targetPeerId?: string | number
  ) {
    if (!this.isConnected() || !this.canSendMutation() || !layerId || width <= 0 || height <= 0) return;

    const encoder = new TextEncoder();
    const layerIdBytes = encoder.encode(layerId);
    if (layerIdBytes.length === 0 || layerIdBytes.length > 256) return;

    let flags = isFullReplace ? MASK_FLAG_FULL_REPLACE : 0;
    let body: Uint8Array;

    if (solidValue !== null) {
      flags |= MASK_FLAG_SOLID_FILL;
      body = new Uint8Array([Math.max(0, Math.min(255, Math.round(solidValue)))]);
    } else if (pixels) {
      const compressed = lz4CompressBlock(pixels);
      if (compressed.byteLength < pixels.byteLength) {
        flags |= MASK_FLAG_LZ4;
        body = compressed;
      } else {
        body = pixels;
      }
    } else {
      return;
    }

    const payloadSize = 2 + layerIdBytes.length + 1 + 16 + body.byteLength;
    const packet = new Uint8Array(11 + payloadSize);
    const view = new DataView(packet.buffer);

    view.setUint8(0, BINARY_MAGIC_0);
    view.setUint8(1, BINARY_MAGIC_1);
    view.setUint8(2, CODE_LAYER_MASK_DATA);
    view.setUint32(3, this.getNextLamport(), true);
    view.setUint32(7, payloadSize, true);

    let offset = 11;
    view.setUint16(offset, layerIdBytes.length, true);
    offset += 2;
    packet.set(layerIdBytes, offset);
    offset += layerIdBytes.length;

    packet[offset++] = flags;
    view.setUint32(offset, x, true);
    view.setUint32(offset + 4, y, true);
    view.setUint32(offset + 8, width, true);
    view.setUint32(offset + 12, height, true);
    offset += 16;

    packet.set(body, offset);
    this.sendBinary(packet, targetPeerId);
  }

  public sendLayerMaskSolid(
    layerId: string,
    width: number,
    height: number,
    value: number = 255,
    isFullReplace: boolean = true,
    targetPeerId?: string | number
  ) {
    if (!this.isConnected() || width <= 0 || height <= 0) return;
    this.sendMaskPacket(layerId, 0, 0, width, height, isFullReplace, value, null, targetPeerId);
  }

  public sendLayerMaskData(
    layerId: string,
    maskCanvas: HTMLCanvasElement,
    rect?: DirtyRect,
    targetPeerId?: string | number
  ) {
    if (!this.isConnected() || !maskCanvas || maskCanvas.width <= 0 || maskCanvas.height <= 0) {
      return;
    }

    const isFull = !rect;
    const x0 = rect ? Math.max(0, Math.min(maskCanvas.width - 1, Math.floor(rect.x))) : 0;
    const y0 = rect ? Math.max(0, Math.min(maskCanvas.height - 1, Math.floor(rect.y))) : 0;
    const x1 = rect
      ? Math.max(x0 + 1, Math.min(maskCanvas.width, Math.ceil(rect.x + rect.width)))
      : maskCanvas.width;
    const y1 = rect
      ? Math.max(y0 + 1, Math.min(maskCanvas.height, Math.ceil(rect.y + rect.height)))
      : maskCanvas.height;
    const totalW = x1 - x0;
    const totalH = y1 - y0;
    if (totalW <= 0 || totalH <= 0) return;

    // Small rects (<= 1024x1024) send in a single packet
    if (totalW * totalH <= MAX_MASK_CHUNK_DIM * MAX_MASK_CHUNK_DIM) {
      const extracted = extractMaskGrayscaleRect(maskCanvas, {
        x: x0,
        y: y0,
        width: totalW,
        height: totalH,
      });
      if (!extracted) return;
      this.sendMaskPacket(
        layerId,
        extracted.x,
        extracted.y,
        extracted.width,
        extracted.height,
        isFull,
        extracted.solidValue,
        extracted.solidValue === null ? extracted.pixels : null,
        targetPeerId
      );
      return;
    }

    // Large masks: chunk into <= 1024x1024 tiles so every packet stays well under the 8MB WS ceiling
    const chunks: Array<{
      x: number;
      y: number;
      width: number;
      height: number;
      solidValue: number | null;
      pixels: Uint8Array | null;
    }> = [];
    for (let cy = y0; cy < y1; cy += MAX_MASK_CHUNK_DIM) {
      const ch = Math.min(MAX_MASK_CHUNK_DIM, y1 - cy);
      for (let cx = x0; cx < x1; cx += MAX_MASK_CHUNK_DIM) {
        const cw = Math.min(MAX_MASK_CHUNK_DIM, x1 - cx);
        const extracted = extractMaskGrayscaleRect(maskCanvas, {
          x: cx,
          y: cy,
          width: cw,
          height: ch,
        });
        if (!extracted) continue;
        chunks.push({
          x: extracted.x,
          y: extracted.y,
          width: extracted.width,
          height: extracted.height,
          solidValue: extracted.solidValue,
          pixels: extracted.solidValue === null ? extracted.pixels : null,
        });
      }
    }

    if (chunks.length === 0) return;

    // Fast collapse if all chunks share the same uniform solid fill
    const firstSolid = chunks[0].solidValue;
    if (firstSolid !== null && chunks.every((c) => c.solidValue === firstSolid)) {
      this.sendMaskPacket(layerId, x0, y0, totalW, totalH, isFull, firstSolid, null, targetPeerId);
      return;
    }

    const MAX_BUFFERED_BYTES = 2 * 1024 * 1024;
    let idx = 0;
    const pump = () => {
      if (!this.isConnected()) return;
      if (this.getBufferedAmount() > MAX_BUFFERED_BYTES) {
        setTimeout(pump, 20);
        return;
      }
      const end = Math.min(idx + 8, chunks.length);
      for (; idx < end; idx++) {
        const c = chunks[idx];
        this.sendMaskPacket(
          layerId,
          c.x,
          c.y,
          c.width,
          c.height,
          false,
          c.solidValue,
          c.pixels,
          targetPeerId
        );
      }
      if (idx < chunks.length) {
        setTimeout(pump, 4);
      }
    };
    pump();
  }

  // --- Perspective Ruler, Straight Ruler, Animation & Canvas Resize Sync ---

  public sendPerspectiveRulerSync(perspectiveRuler: PerspectiveRuler | null, immediate = false) {
    if (!this.isConnected() || !this.canSendMutation()) return;
    this.pendingPerspectiveRuler = perspectiveRuler;
    const flush = () => {
      this.perspectiveThrottleTimer = null;
      if (!this.isConnected() || !this.canSendMutation() || this.pendingPerspectiveRuler === undefined) return;
      const value = this.pendingPerspectiveRuler;
      this.pendingPerspectiveRuler = undefined;
      const msg: PerspectiveRulerSyncMessage = {
        type: 'PERSPECTIVE_RULER_SYNC',
        perspectiveRuler: value,
        lamport: this.getNextLamport(),
      };
      this.sendMessage(msg);
    };
    if (immediate) {
      if (this.perspectiveThrottleTimer) clearTimeout(this.perspectiveThrottleTimer);
      flush();
    } else if (!this.perspectiveThrottleTimer) {
      this.perspectiveThrottleTimer = setTimeout(flush, STATE_SYNC_THROTTLE_MS);
    }
  }

  public sendStraightRulerSync(straightRuler: StraightRuler | null, immediate = false) {
    if (!this.isConnected() || !this.canSendMutation()) return;
    this.pendingStraightRuler = straightRuler;
    const flush = () => {
      this.straightThrottleTimer = null;
      if (!this.isConnected() || !this.canSendMutation() || this.pendingStraightRuler === undefined) return;
      const value = this.pendingStraightRuler;
      this.pendingStraightRuler = undefined;
      const msg: StraightRulerSyncMessage = {
        type: 'STRAIGHT_RULER_SYNC',
        straightRuler: value,
        lamport: this.getNextLamport(),
      };
      this.sendMessage(msg);
    };
    if (immediate) {
      if (this.straightThrottleTimer) clearTimeout(this.straightThrottleTimer);
      flush();
    } else if (!this.straightThrottleTimer) {
      this.straightThrottleTimer = setTimeout(flush, STATE_SYNC_THROTTLE_MS);
    }
  }

  public sendAnimationSync(animationTimeline: AnimationTimeline | null, immediate = false) {
    if (!this.isConnected() || !this.canSendMutation()) return;
    const wireTimeline: AnimationTimeline | null = animationTimeline
      ? { ...animationTimeline, isPlaying: false }
      : null;
    this.pendingAnimationTimeline = wireTimeline;
    const flush = () => {
      this.animationThrottleTimer = null;
      if (!this.isConnected() || !this.canSendMutation() || this.pendingAnimationTimeline === undefined) return;
      const value = this.pendingAnimationTimeline;
      this.pendingAnimationTimeline = undefined;
      const msg: AnimationSyncMessage = {
        type: 'ANIMATION_SYNC',
        animationTimeline: value,
        lamport: this.getNextLamport(),
      };
      this.sendMessage(msg);
    };
    if (immediate) {
      if (this.animationThrottleTimer) clearTimeout(this.animationThrottleTimer);
      flush();
    } else if (!this.animationThrottleTimer) {
      this.animationThrottleTimer = setTimeout(flush, STATE_SYNC_THROTTLE_MS);
    }
  }

  public sendCanvasResize(dimensions: CanvasDimensions, options: ResizeCanvasOptions) {
    if (!this.isConnected() || !this.canSendMutation()) return;
    const msg: CanvasResizeMessage = {
      type: 'CANVAS_RESIZE',
      dimensions,
      options,
      lamport: this.getNextLamport(),
    };
    this.sendMessage(msg);
  }

  // --- Room Roles & Moderation (Host-authoritative) ---

  public sendPeerRoleUpdate(targetPeerId: string | number, role: CollabRole) {
    if (!this.isConnected() || this.localRole !== 'host') return;
    const msg: PeerRoleUpdateMessage = {
      type: 'PEER_ROLE_UPDATE',
      targetPeerId,
      role,
    };
    this.sendMessage(msg);
  }

  public sendPeerKick(targetPeerId: string | number, reason?: string) {
    if (!this.isConnected() || this.localRole !== 'host') return;
    const msg: PeerKickMessage = {
      type: 'PEER_KICK',
      targetPeerId,
      ...(reason ? { reason } : {}),
    };
    this.sendMessage(msg);
  }

  public sendPeerBan(targetPeerId: string | number, reason?: string) {
    if (!this.isConnected() || this.localRole !== 'host') return;
    const msg: PeerBanMessage = {
      type: 'PEER_BAN',
      targetPeerId,
      ...(reason ? { reason } : {}),
    };
    this.sendMessage(msg);
  }

  public sendPeerUnban(targetPeerId: string | number) {
    if (!this.isConnected() || this.localRole !== 'host') return;
    const msg: PeerUnbanMessage = {
      type: 'PEER_UNBAN',
      targetPeerId,
    };
    this.sendMessage(msg);
  }

  public sendAccessDenied(
    code: AccessDeniedCode,
    reason: string,
    targetPeerId?: string | number
  ) {
    if (!this.isConnected()) return;
    const msg: AccessDeniedMessage = {
      type: 'ACCESS_DENIED',
      code,
      reason,
      ...(targetPeerId !== undefined ? { targetPeerId } : {}),
    };
    this.sendMessage(msg);
  }

  // --- Radar Ping ---

  public sendPing(x: number, y: number) {
    if (!this.isConnected() || !this.currentPeer) return;

    const msg: CanvasPingMessage = {
      type: 'CANVAS_PING',
      sender: this.currentPeer,
      x,
      y,
      timestamp: Date.now(),
    };
    this.sendMessage(msg);
    this.notifyHandlers(msg);
  }
}

export const multiplayerService = new MultiplayerService();
