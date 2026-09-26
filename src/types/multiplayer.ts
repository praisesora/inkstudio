import { Point, BrushSettings, ToolType, DirtyRect, CanvasDimensions, CanvasColorMode, LayerItem } from './editor';

export interface CollabPeer {
  id: string | number;
  name: string;
  color: string;
  isHost?: boolean;
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
  | 'CURSOR_MOVE'
  | 'STROKE_START'
  | 'STROKE_CHUNK'
  | 'STROKE_FINISH'
  | 'LAYER_ADD'
  | 'LAYER_DELETE'
  | 'LAYER_CLEAR'
  | 'LAYER_RENAME'
  | 'LAYER_VISIBILITY'
  | 'LAYER_OPACITY'
  | 'DOC_SYNC_REQUEST'
  | 'DOC_SYNC_RESPONSE'
  | 'CANVAS_PING';

export interface BaseMultiplayerMessage {
  type: MultiplayerMessageType;
  senderId?: string | number;
}

export interface RoomInfoMessage extends BaseMultiplayerMessage {
  type: 'ROOM_INFO';
  clientId: number;
  roomName: string;
}

export interface JoinRequestMessage extends BaseMultiplayerMessage {
  type: 'JOIN_REQUEST';
  peer: CollabPeer;
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
}

export interface PeerJoinedMessage extends BaseMultiplayerMessage {
  type: 'PEER_JOINED';
  peer: CollabPeer;
}

export interface PeerLeftMessage extends BaseMultiplayerMessage {
  type: 'PEER_LEFT';
  peerId: string | number;
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
  tool: ToolType;
  startPoint: Point;
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
}

export interface LayerActionMessage extends BaseMultiplayerMessage {
  type: 'LAYER_ADD' | 'LAYER_DELETE' | 'LAYER_CLEAR' | 'LAYER_RENAME' | 'LAYER_VISIBILITY' | 'LAYER_OPACITY';
  layerId: string;
  layerItem?: LayerItem;
  newName?: string;
  visible?: boolean;
  opacity?: number;
  imageDataUrl?: string;
}

export interface DocSyncRequestMessage extends BaseMultiplayerMessage {
  type: 'DOC_SYNC_REQUEST';
  targetPeerId: string | number;
}

export interface DocSyncResponseMessage extends BaseMultiplayerMessage {
  type: 'DOC_SYNC_RESPONSE';
  targetPeerId: string | number;
  dimensions: CanvasDimensions;
  colorMode: CanvasColorMode;
  layers: LayerItem[];
  layerDataUrls: Record<string, string>; // base64 layer thumbnails / images
}

export interface CanvasPingMessage extends BaseMultiplayerMessage {
  type: 'CANVAS_PING';
  sender: CollabPeer;
  x: number;
  y: number;
  timestamp: number;
}

export interface PeerDisconnectedMessage extends BaseMultiplayerMessage {
  type: 'PEER_DISCONNECTED';
  clientId: number;
}

export type MultiplayerMessage =
  | RoomInfoMessage
  | JoinRequestMessage
  | JoinAcceptedMessage
  | PeerJoinedMessage
  | PeerLeftMessage
  | PeerDisconnectedMessage
  | CursorMoveMessage
  | StrokeStartMessage
  | StrokeChunkMessage
  | StrokeFinishMessage
  | LayerActionMessage
  | DocSyncRequestMessage
  | DocSyncResponseMessage
  | CanvasPingMessage;


export interface SessionHostInfo {
  isRunning: boolean;
  port: number;
  localIp: string;
  roomName: string;
  inviteUrl: string;
  peerCount: number;
  isGlobal?: boolean;
  localInviteUrl?: string;
}
