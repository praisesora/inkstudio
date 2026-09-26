import {
  CollabPeer,
  MultiplayerMessage,
  StrokeStartMessage,
  StrokeChunkMessage,
  StrokeFinishMessage,
  CursorMoveMessage,
  LayerActionMessage,
  CanvasPingMessage,
} from '../types/multiplayer';
import { Point, BrushSettings, ToolType, DirtyRect, LayerItem } from '../types/editor';

type MessageHandler = (msg: MultiplayerMessage) => void;

class MultiplayerService {
  private ws: WebSocket | null = null;
  private messageHandlers: Set<MessageHandler> = new Set();
  private closeHandlers: Set<() => void> = new Set();
  private errorHandlers: Set<(err: Event) => void> = new Set();
  private currentPeer: CollabPeer | null = null;

  // Throttling for cursor movement (max 60fps)
  private lastCursorSendTime = 0;
  private pendingCursor: { x: number; y: number; isDrawing: boolean; tool: ToolType } | null = null;
  private cursorThrottleRaf: number | null = null;

  public isConnected(): boolean {
    return this.ws !== null && this.ws.readyState === WebSocket.OPEN;
  }

  public getPeer(): CollabPeer | null {
    return this.currentPeer;
  }

  public connect(url: string, peer: CollabPeer): Promise<void> {
    return new Promise((resolve, reject) => {
      this.disconnect();
      this.currentPeer = peer;

      try {
        const ws = new WebSocket(url);
        this.ws = ws;

        ws.onopen = () => {
          // Send join handshake
          this.sendMessage({
            type: 'JOIN_REQUEST',
            peer: this.currentPeer!,
          });
          resolve();
        };

        ws.onmessage = (event) => {
          try {
            const data: MultiplayerMessage = JSON.parse(event.data);
            this.notifyHandlers(data);
          } catch (err) {
            console.error('[Multiplayer] Failed to parse message JSON:', err, event.data);
          }
        };

        ws.onclose = () => {
          this.ws = null;
          this.closeHandlers.forEach((h) => h());
        };

        ws.onerror = (err) => {
          this.errorHandlers.forEach((h) => h(err));
          reject(new Error(`Failed to connect to socket server (${url})`));
        };
      } catch (err: any) {
        reject(new Error(err?.message || `WebSocket initialization error (${url})`));
      }
    });
  }

  public disconnect() {
    if (this.ws) {
      if (this.currentPeer) {
        this.sendMessage({
          type: 'PEER_LEFT',
          peerId: this.currentPeer.id,
        });
      }
      this.ws.close();
      this.ws = null;
    }
    this.currentPeer = null;
    if (this.cursorThrottleRaf) {
      cancelAnimationFrame(this.cursorThrottleRaf);
      this.cursorThrottleRaf = null;
    }
  }

  public onMessage(handler: MessageHandler): () => void {
    this.messageHandlers.add(handler);
    return () => this.messageHandlers.delete(handler);
  }

  public onClose(handler: () => void): () => void {
    this.closeHandlers.add(handler);
    return () => this.closeHandlers.delete(handler);
  }

  public onError(handler: (err: Event) => void): () => void {
    this.errorHandlers.add(handler);
    return () => this.errorHandlers.delete(handler);
  }

  public sendMessage(msg: MultiplayerMessage) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      if (!msg.senderId && this.currentPeer) {
        msg.senderId = this.currentPeer.id;
      }
      this.ws.send(JSON.stringify(msg));
    }
  }

  private notifyHandlers(msg: MultiplayerMessage) {
    this.messageHandlers.forEach((handler) => handler(msg));
  }

  // --- Drawing Events ---

  public sendStrokeStart(
    strokeId: string,
    layerId: string,
    brushSettings: BrushSettings,
    tool: ToolType,
    startPoint: Point
  ) {
    if (!this.isConnected() || !this.currentPeer) return;

    const msg: StrokeStartMessage = {
      type: 'STROKE_START',
      strokeId,
      peerId: this.currentPeer.id,
      peerName: this.currentPeer.name,
      peerColor: this.currentPeer.color,
      layerId,
      brushSettings,
      tool,
      startPoint,
    };
    this.sendMessage(msg);
  }

  public sendStrokeChunk(strokeId: string, points: Point[]) {
    if (!this.isConnected() || !this.currentPeer || points.length === 0) return;

    const msg: StrokeChunkMessage = {
      type: 'STROKE_CHUNK',
      strokeId,
      peerId: this.currentPeer.id,
      points,
    };
    this.sendMessage(msg);
  }

  public sendStrokeFinish(strokeId: string, layerId: string, endPoint: Point, dirtyRect?: DirtyRect) {
    if (!this.isConnected() || !this.currentPeer) return;

    const msg: StrokeFinishMessage = {
      type: 'STROKE_FINISH',
      strokeId,
      peerId: this.currentPeer.id,
      layerId,
      endPoint,
      dirtyRect,
    };
    this.sendMessage(msg);
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
    const msg: CursorMoveMessage = {
      type: 'CURSOR_MOVE',
      peerId: this.currentPeer.id,
      peerName: this.currentPeer.name,
      peerColor: this.currentPeer.color,
      x: this.pendingCursor.x,
      y: this.pendingCursor.y,
      isDrawing: this.pendingCursor.isDrawing,
      tool: this.pendingCursor.tool,
    };
    this.sendMessage(msg);
    this.pendingCursor = null;
  }

  // --- Layer Synchronization ---

  public sendLayerAdd(layerItem: LayerItem, imageDataUrl?: string) {
    if (!this.isConnected()) return;
    const msg: LayerActionMessage = {
      type: 'LAYER_ADD',
      layerId: layerItem.id,
      layerItem,
      imageDataUrl,
    };
    this.sendMessage(msg);
  }

  public sendLayerDelete(layerId: string) {
    if (!this.isConnected()) return;
    const msg: LayerActionMessage = {
      type: 'LAYER_DELETE',
      layerId,
    };
    this.sendMessage(msg);
  }

  public sendLayerClear(layerId: string) {
    if (!this.isConnected()) return;
    const msg: LayerActionMessage = {
      type: 'LAYER_CLEAR',
      layerId,
    };
    this.sendMessage(msg);
  }

  public sendLayerRename(layerId: string, newName: string) {
    if (!this.isConnected()) return;
    const msg: LayerActionMessage = {
      type: 'LAYER_RENAME',
      layerId,
      newName,
    };
    this.sendMessage(msg);
  }

  public sendLayerVisibility(layerId: string, visible: boolean) {
    if (!this.isConnected()) return;
    const msg: LayerActionMessage = {
      type: 'LAYER_VISIBILITY',
      layerId,
      visible,
    };
    this.sendMessage(msg);
  }

  public sendLayerOpacity(layerId: string, opacity: number) {
    if (!this.isConnected()) return;
    const msg: LayerActionMessage = {
      type: 'LAYER_OPACITY',
      layerId,
      opacity,
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
