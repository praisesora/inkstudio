import {
  AnimationTimeline,
  BrushSettings,
  CanvasColorMode,
  CanvasDimensions,
  DirtyRect,
  LayerItem,
  Point,
  ToolType,
  VectorStroke,
} from './editor';
import { PerspectiveRuler, StraightRuler } from './perspective';
import { ResizeCanvasOptions } from './settings';

export type CollabRole = 'host' | 'editor' | 'viewer';

export type ConnectionStatus = 'disconnected' | 'connecting' | 'connected' | 'reconnecting';

export type AccessDeniedCode =
  | 'BANNED'
  | 'KICKED'
  | 'VIEWER_READONLY'
  | 'LAYER_LOCKED'
  | 'NOT_OWNER'
  | 'FORBIDDEN';

export interface CollabPeer {
  id: string | number;
  name: string;
  color: string;
  isHost?: boolean;
  role?: CollabRole;
  isDrawing?: boolean;
  x?: number;
  y?: number;
  tool?: ToolType;
  lastActive?: number;
}

export type MultiplayerMessageType =
  | 'ROOM_INFO'
  | 'JOIN_REQUEST'
  | 'JOIN_ACCEPTED'
  | 'PEER_JOINED'
  | 'PEER_LEFT'
  | 'PEER_DISCONNECTED'
  | 'PEER_ROLE_UPDATE'
  | 'PEER_KICK'
  | 'PEER_BAN'
  | 'PEER_UNBAN'
  | 'ACCESS_DENIED'
  | 'CURSOR_MOVE'
  | 'STROKE_START'
  | 'STROKE_CHUNK'
  | 'STROKE_FINISH'
  | 'BRUSH_ASSET_DATA'
  | 'BRUSH_ASSET_REQUEST'
  | 'LAYER_ADD'
  | 'LAYER_DELETE'
  | 'LAYER_CLEAR'
  | 'LAYER_RENAME'
  | 'LAYER_VISIBILITY'
  | 'LAYER_OPACITY'
  | 'LAYER_UPDATE'
  | 'LAYER_TREE_SYNC'
  | 'BINARY_MASK'
  | 'PERSPECTIVE_RULER_SYNC'
  | 'STRAIGHT_RULER_SYNC'
  | 'ANIMATION_SYNC'
  | 'CANVAS_RESIZE'
  | 'DOC_SYNC_REQUEST'
  | 'DOC_SYNC_RESPONSE'
  | 'CANVAS_PING'
  | 'BINARY_TILE'
  | 'SELECTIVE_UNDO';

/**
 * JSON-safe wire representation of a LayerItem.
 * Excludes DOM-only/transient fields (`maskCanvas`, `thumbnailUrl`, `maskThumbnailUrl`).
 */
export type WireLayerItem = Omit<
  LayerItem,
  'maskCanvas' | 'thumbnailUrl' | 'maskThumbnailUrl'
> & {
  /** Whether the layer owns a non-destructive grayscale mask canvas (pixel bytes stream via BINARY_MASK). */
  hasMask?: boolean;
};

export type LayerClearableField =
  | 'alphaLocked'
  | 'clipped'
  | 'isReference'
  | 'isToneLayer'
  | 'toneEnabled'
  | 'toneFrequency'
  | 'toneAngle'
  | 'toneDotShape'
  | 'toneDensity'
  | 'toneDensityType'
  | 'layerColorEnabled'
  | 'layerColor'
  | 'layerSubColor'
  | 'expressionColor'
  | 'monoThreshold'
  | 'monoExpressBlack'
  | 'monoExpressWhite'
  | 'maskEnabled'
  | 'maskLinked'
  | 'maskVersion'
  | 'hasMask'
  | 'adjustmentData'
  | 'styles'
  | 'vectorStrokes'
  | 'comicFrames'
  | 'textData'
  | 'balloonData'
  | 'balloons'
  | 'ownerPeerId'
  | 'ownerPeerName'
  | 'reservedByPeerId'
  | 'reservedByPeerName';

export interface SubTipAssetRef {
  hash: string;
  width: number;
  height: number;
  isColor?: boolean;
}

export interface BrushAssetRefs {
  tipHash?: string;
  dualTipHash?: string;
  paperTextureHash?: string;
  subTipHashes?: SubTipAssetRef[];
}

export interface BaseMultiplayerMessage {
  type: MultiplayerMessageType;
  senderId?: string | number;
  /** Server-assigned monotonic sequence number for deterministic ordering. */
  seq?: number;
}

export interface RoomInfoMessage extends BaseMultiplayerMessage {
  type: 'ROOM_INFO';
  clientId: number;
  roomName: string;
  serverSeq?: number;
}

export interface JoinRequestMessage extends BaseMultiplayerMessage {
  type: 'JOIN_REQUEST';
  peer: CollabPeer;
  isReconnect?: boolean;
  sinceSeq?: number;
}

export interface JoinAcceptedMessage extends BaseMultiplayerMessage {
  type: 'JOIN_ACCEPTED';
  targetPeerId?: string | number;
  roomName: string;
  peers: CollabPeer[];
  hostId: string | number;
  docDimensions: CanvasDimensions;
  colorMode: CanvasColorMode;
  assignedLayerId?: string;
  assignedRole?: CollabRole;
  isReconnect?: boolean;
  serverSeq?: number;
}

export interface PeerJoinedMessage extends BaseMultiplayerMessage {
  type: 'PEER_JOINED';
  peer: CollabPeer;
}

export interface PeerLeftMessage extends BaseMultiplayerMessage {
  type: 'PEER_LEFT';
  peerId: string | number;
}

export interface PeerDisconnectedMessage extends BaseMultiplayerMessage {
  type: 'PEER_DISCONNECTED';
  peerId: string | number;
}

export interface PeerRoleUpdateMessage extends BaseMultiplayerMessage {
  type: 'PEER_ROLE_UPDATE';
  targetPeerId: string | number;
  role: CollabRole;
}

export interface PeerKickMessage extends BaseMultiplayerMessage {
  type: 'PEER_KICK';
  targetPeerId: string | number;
  reason?: string;
}

export interface PeerBanMessage extends BaseMultiplayerMessage {
  type: 'PEER_BAN';
  targetPeerId: string | number;
  reason?: string;
}

export interface PeerUnbanMessage extends BaseMultiplayerMessage {
  type: 'PEER_UNBAN';
  targetPeerId: string | number;
}

export interface AccessDeniedMessage extends BaseMultiplayerMessage {
  type: 'ACCESS_DENIED';
  targetPeerId?: string | number;
  code: AccessDeniedCode;
  reason: string;
}

export interface CursorMoveMessage extends BaseMultiplayerMessage {
  type: 'CURSOR_MOVE';
  peerId: string | number;
  peerName?: string;
  peerColor?: string;
  x: number;
  y: number;
  isDrawing: boolean;
  tool: ToolType;
}

export interface StrokeStartMessage extends BaseMultiplayerMessage {
  type: 'STROKE_START';
  strokeId: string;
  peerId: string | number;
  peerName: string;
  peerColor: string;
  layerId: string;
  brushSettings: BrushSettings;
  brushAssetRefs?: BrushAssetRefs;
  tool: ToolType;
  startPoint: Point;
}

export interface BrushAssetDataMessage extends BaseMultiplayerMessage {
  type: 'BRUSH_ASSET_DATA';
  hash: string;
  mime: string;
  data: Uint8Array;
}

export interface BrushAssetRequestMessage extends BaseMultiplayerMessage {
  type: 'BRUSH_ASSET_REQUEST';
  hash: string;
  targetPeerId?: string | number;
}

export interface StrokeChunkMessage extends BaseMultiplayerMessage {
  type: 'STROKE_CHUNK';
  strokeId: string;
  peerId: string | number;
  points: Point[];
}

export interface StrokeFinishMessage extends BaseMultiplayerMessage {
  type: 'STROKE_FINISH';
  strokeId: string;
  peerId: string | number;
  layerId: string;
  endPoint: Point;
  dirtyRect?: DirtyRect;
  vectorStroke?: VectorStroke;
}

export interface LayerActionMessage extends BaseMultiplayerMessage {
  type: 'LAYER_ADD' | 'LAYER_DELETE' | 'LAYER_CLEAR' | 'LAYER_RENAME' | 'LAYER_VISIBILITY' | 'LAYER_OPACITY';
  layerId: string;
  layerItem?: WireLayerItem;
  insertIndex?: number;
  newName?: string;
  visible?: boolean;
  opacity?: number;
}

export interface LayerUpdateMessage extends BaseMultiplayerMessage {
  type: 'LAYER_UPDATE';
  layerId: string;
  patch: Partial<WireLayerItem>;
  clearedFields?: LayerClearableField[];
  lamport?: number;
}

export interface LayerTreeSyncMessage extends BaseMultiplayerMessage {
  type: 'LAYER_TREE_SYNC';
  layers: WireLayerItem[];
  lamport: number;
  dirtyTileLayerIds?: string[];
  removedLayerIds?: string[];
}

export interface LayerMaskDataMessage extends BaseMultiplayerMessage {
  type: 'BINARY_MASK';
  layerId: string;
  x: number;
  y: number;
  width: number;
  height: number;
  isFullReplace: boolean;
  /** Non-undefined when the entire rect is a uniform grayscale value (0..255). */
  solidFill?: number;
  /** 1-byte-per-pixel grayscale luminance values (width * height), null when solidFill is used. */
  data: Uint8Array | null;
}

export interface PerspectiveRulerSyncMessage extends BaseMultiplayerMessage {
  type: 'PERSPECTIVE_RULER_SYNC';
  perspectiveRuler: PerspectiveRuler | null;
  lamport?: number;
}

export interface StraightRulerSyncMessage extends BaseMultiplayerMessage {
  type: 'STRAIGHT_RULER_SYNC';
  straightRuler: StraightRuler | null;
  lamport?: number;
}

export interface AnimationSyncMessage extends BaseMultiplayerMessage {
  type: 'ANIMATION_SYNC';
  animationTimeline: AnimationTimeline | null;
  lamport?: number;
}

export interface CanvasResizeMessage extends BaseMultiplayerMessage {
  type: 'CANVAS_RESIZE';
  dimensions: CanvasDimensions;
  options: ResizeCanvasOptions;
  lamport?: number;
}

export interface DocSyncRequestMessage extends BaseMultiplayerMessage {
  type: 'DOC_SYNC_REQUEST';
  targetPeerId: string | number;
  /** Optional last applied server sequence number for incremental op-log catch-up. */
  sinceSeq?: number;
}

export interface DocSyncResponseMessage extends BaseMultiplayerMessage {
  type: 'DOC_SYNC_RESPONSE';
  targetPeerId: string | number;
  roomName?: string;
  assignedLayerId?: string;
  dimensions: CanvasDimensions;
  colorMode: CanvasColorMode;
  layers: WireLayerItem[];
  perspectiveRuler?: PerspectiveRuler | null;
  straightRuler?: StraightRuler | null;
  animationTimeline?: AnimationTimeline | null;
}

export interface CanvasPingMessage extends BaseMultiplayerMessage {
  type: 'CANVAS_PING';
  sender: CollabPeer;
  x: number;
  y: number;
  timestamp: number;
}

export interface TileStreamMessage extends BaseMultiplayerMessage {
  type: 'BINARY_TILE';
  layerId: string;
  tileX: number;
  tileY: number;
  format: 'monochrome-1bit' | 'grayscale-8bit' | 'color-32bit';
  version: number;
  /** Raw tile bytes (decompressed from LZ4 on wire) or null to delete/clear the tile. */
  data: Uint8Array | null;
}

export interface SelectiveUndoMessage extends BaseMultiplayerMessage {
  type: 'SELECTIVE_UNDO';
  strokeId: string;
  peerId: string | number;
  lamport: number;
}

export type MultiplayerMessage =
  | RoomInfoMessage
  | JoinRequestMessage
  | JoinAcceptedMessage
  | PeerJoinedMessage
  | PeerLeftMessage
  | PeerDisconnectedMessage
  | PeerRoleUpdateMessage
  | PeerKickMessage
  | PeerBanMessage
  | PeerUnbanMessage
  | AccessDeniedMessage
  | CursorMoveMessage
  | StrokeStartMessage
  | StrokeChunkMessage
  | StrokeFinishMessage
  | BrushAssetDataMessage
  | BrushAssetRequestMessage
  | LayerActionMessage
  | LayerUpdateMessage
  | LayerTreeSyncMessage
  | LayerMaskDataMessage
  | PerspectiveRulerSyncMessage
  | StraightRulerSyncMessage
  | AnimationSyncMessage
  | CanvasResizeMessage
  | DocSyncRequestMessage
  | DocSyncResponseMessage
  | CanvasPingMessage
  | TileStreamMessage
  | SelectiveUndoMessage;


export interface SessionHostInfo {
  isRunning: boolean;
  port: number;
  localIp: string;
  roomName: string;
  roomToken?: string;
  inviteUrl: string;
  peerCount: number;
  isGlobal?: boolean;
  localInviteUrl?: string;
}
