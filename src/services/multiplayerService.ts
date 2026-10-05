import {
  CollabPeer,
  MultiplayerMessage,
  StrokeStartMessage,
  StrokeChunkMessage,
  StrokeFinishMessage,
  CursorMoveMessage,
  LayerActionMessage,
  CanvasPingMessage,
  TileStreamMessage,
  SelectiveUndoMessage,
} from '../types/multiplayer';
import { Point, BrushSettings, ToolType, DirtyRect, LayerItem, VectorStroke } from '../types/editor';
import { TileBuffer, serializeTileBuffer, deserializeTileBuffer } from '../utils/tileEngine';

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

class MultiplayerService {
  private ws: WebSocket | null = null;
  private messageHandlers: Set<MessageHandler> = new Set();
  private closeHandlers: Set<() => void> = new Set();
  private errorHandlers: Set<(err: Event) => void> = new Set();
  private currentPeer: CollabPeer | null = null;

  // Lamport Logical Clock for Vector CRDT and deterministic ordering
  private lamportClock = 0;

  // Throttling for cursor movement (max 60fps)
  private lastCursorSendTime = 0;
  private pendingCursor: { x: number; y: number; isDrawing: boolean; tool: ToolType } | null = null;
  private cursorThrottleRaf: number | null = null;

  public getNextLamport(): number {
    return ++this.lamportClock;
  }

  public updateLamport(remoteLamport: number): void {
    this.lamportClock = Math.max(this.lamportClock, remoteLamport) + 1;
  }

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
        ws.binaryType = 'arraybuffer';
        this.ws = ws;

        ws.onopen = () => {
          // Send join handshake
          this.sendMessage({
            type: 'JOIN_REQUEST',
            peer: this.currentPeer!,
          });
          resolve();
        };

        ws.onmessage = async (event) => {
          try {
            if (event.data instanceof ArrayBuffer) {
              const parsed = this.decodeBinaryPacket(event.data);
              if (parsed) {
                this.notifyHandlers(parsed);
              }
            } else if (event.data instanceof Blob) {
              const buf = await event.data.arrayBuffer();
              const parsed = this.decodeBinaryPacket(buf);
              if (parsed) {
                this.notifyHandlers(parsed);
              }
            } else {
              const data: MultiplayerMessage = JSON.parse(event.data);
              this.notifyHandlers(data);
            }
          } catch (err) {
            console.error('[Multiplayer] Failed to parse message:', err, event.data);
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

  public sendBinary(buffer: ArrayBuffer | Uint8Array) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(buffer as any);
    }
  }

  private notifyHandlers(msg: MultiplayerMessage) {
    this.messageHandlers.forEach((handler) => handler(msg));
  }

  // --- Binary Packet Encoding & Decoding ---

  private decodeBinaryPacket(buf: ArrayBuffer): MultiplayerMessage | null {
    if (buf.byteLength < 11) return null;
    const view = new DataView(buf);

    // Verify magic
    if (view.getUint8(0) !== BINARY_MAGIC_0 || view.getUint8(1) !== BINARY_MAGIC_1) {
      return null;
    }

    const code = view.getUint8(2);
    const lamport = view.getUint32(3, true);
    this.updateLamport(lamport);

    const payloadLen = view.getUint32(7, true);
    const payloadBytes = new Uint8Array(buf, 11, payloadLen);
    const decoder = new TextDecoder();

    switch (code) {
      case CODE_STROKE_START: {
        const jsonStr = decoder.decode(payloadBytes);
        const data = JSON.parse(jsonStr);
        return {
          type: 'STROKE_START',
          strokeId: data.strokeId,
          peerId: data.peerId,
          peerName: data.peerName,
          peerColor: data.peerColor,
          layerId: data.layerId,
          brushSettings: data.brushSettings,
          tool: data.tool,
          startPoint: data.startPoint,
        } as StrokeStartMessage;
      }

      case CODE_STROKE_CHUNK: {
        // Format: [strokeIdLen: uint16, strokeIdStr, peerIdLen: uint16, peerIdStr, pointCount: uint16, points...]
        let offset = 0;
        const pView = new DataView(payloadBytes.buffer, payloadBytes.byteOffset, payloadBytes.byteLength);

        const sIdLen = pView.getUint16(offset, true);
        offset += 2;
        const strokeId = decoder.decode(payloadBytes.subarray(offset, offset + sIdLen));
        offset += sIdLen;

        const pIdLen = pView.getUint16(offset, true);
        offset += 2;
        const peerId = decoder.decode(payloadBytes.subarray(offset, offset + pIdLen));
        offset += pIdLen;

        const pointCount = pView.getUint16(offset, true);
        offset += 2;

        const points: Point[] = [];
        for (let i = 0; i < pointCount; i++) {
          const x = pView.getFloat32(offset, true);
          const y = pView.getFloat32(offset + 4, true);
          const pressure = pView.getFloat32(offset + 8, true);
          const width = pView.getFloat32(offset + 12, true);
          offset += 16;
          points.push({ x, y, pressure, width });
        }

        return {
          type: 'STROKE_CHUNK',
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
          strokeId: data.strokeId,
          peerId: data.peerId,
          layerId: data.layerId,
          endPoint: data.endPoint,
          dirtyRect: data.dirtyRect,
        } as StrokeFinishMessage;
      }

      case CODE_TILE_DELTA: {
        // Format: [layerIdLen: uint16, layerIdStr, serializedTileBuffer...]
        let offset = 0;
        const pView = new DataView(payloadBytes.buffer, payloadBytes.byteOffset, payloadBytes.byteLength);
        const layerIdLen = pView.getUint16(offset, true);
        offset += 2;
        const layerId = decoder.decode(payloadBytes.subarray(offset, offset + layerIdLen));
        offset += layerIdLen;

        const tilePacket = payloadBytes.subarray(offset);
        const tile = deserializeTileBuffer(layerId, tilePacket);

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

      case CODE_CURSOR_MOVE: {
        const pView = new DataView(payloadBytes.buffer, payloadBytes.byteOffset, payloadBytes.byteLength);
        let offset = 0;
        const pIdLen = pView.getUint16(offset, true);
        offset += 2;
        const peerId = decoder.decode(payloadBytes.subarray(offset, offset + pIdLen));
        offset += pIdLen;

        const x = pView.getFloat32(offset, true);
        const y = pView.getFloat32(offset + 4, true);
        const isDrawing = pView.getUint8(offset + 8) === 1;
        const toolCode = pView.getUint8(offset + 9);
        const tool: ToolType = toolCode === 1 ? 'eraser' : 'brush';

        return {
          type: 'CURSOR_MOVE',
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
          strokeId: data.strokeId,
          peerId: data.peerId,
          lamport: data.lamport,
        } as SelectiveUndoMessage;
      }

      default:
        return null;
    }
  }

  // --- Drawing Events via Compact Binary Packets ---

  public sendStrokeStart(
    strokeId: string,
    layerId: string,
    brushSettings: BrushSettings,
    tool: ToolType,
    startPoint: Point
  ) {
    if (!this.isConnected() || !this.currentPeer) return;

    const encoder = new TextEncoder();
    const payloadStr = JSON.stringify({
      strokeId,
      peerId: this.currentPeer.id,
      peerName: this.currentPeer.name,
      peerColor: this.currentPeer.color,
      layerId,
      brushSettings,
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
    if (!this.isConnected() || !this.currentPeer || points.length === 0) return;

    const encoder = new TextEncoder();
    const strokeIdBytes = encoder.encode(strokeId);
    const peerIdBytes = encoder.encode(String(this.currentPeer.id));

    // Size: 2 + strokeIdBytes.length + 2 + peerIdBytes.length + 2 + (points.length * 16)
    const payloadSize = 6 + strokeIdBytes.length + peerIdBytes.length + points.length * 16;
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
      offset += 16;
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
    if (!this.isConnected() || !this.currentPeer) return;

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
   * Stream a single sparse tile delta (e.g. from flood fill or progressive document sync).
   */
  public sendTileDelta(layerId: string, tile: TileBuffer) {
    if (!this.isConnected()) return;

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
    this.sendBinary(packet);
  }

  /**
   * Broadcast a selective collaborative undo command (undoing a stroke without reverting peer strokes).
   */
  public sendSelectiveUndo(strokeId: string) {
    if (!this.isConnected() || !this.currentPeer) return;

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

    view.setFloat32(offset, this.pendingCursor.x, true);
    view.setFloat32(offset + 4, this.pendingCursor.y, true);
    view.setUint8(offset + 8, this.pendingCursor.isDrawing ? 1 : 0);
    view.setUint8(offset + 9, this.pendingCursor.tool === 'eraser' ? 1 : 0);

    this.sendBinary(packet);
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
