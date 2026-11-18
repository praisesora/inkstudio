import { zipSync } from 'fflate';
import { AnimationTimeline, OnionSkinSettings, LayerItem } from '../types/editor';

export interface OnionSkinFrameInfo {
  frame: number;
  layerId: string;
  tint: string;
  opacity: number;
  direction: 'prev' | 'next';
}

/**
 * Creates default animation timeline settings.
 */
export function createDefaultAnimationTimeline(initialLayers: LayerItem[] = []): AnimationTimeline {
  const cels: Record<number, string> = {};

  // If there are initial raster layers, assign the first to frame 0
  const firstRaster = initialLayers.find((l) => l.type === 'raster');
  if (firstRaster) {
    cels[0] = firstRaster.id;
  }

  const defaultOnionSkin: OnionSkinSettings = {
    enabled: true,
    prevFrames: 2,
    nextFrames: 2,
    prevTint: '#00bcd4', // Cyan
    nextTint: '#ec4899', // Magenta
    opacity: 0.35,
  };

  return {
    fps: 12,
    totalFrames: 24,
    currentFrame: 0,
    cels,
    onionSkin: defaultOnionSkin,
    isPlaying: false,
    loop: true,
  };
}

/**
 * Resolves active cel layer ID for a specific frame index.
 */
export function getFrameCelLayerId(timeline: AnimationTimeline, frame: number): string | null {
  return timeline.cels[frame] ?? null;
}

/**
 * Maps a cel layer ID to a specific frame.
 */
export function setFrameCel(
  timeline: AnimationTimeline,
  frame: number,
  layerId: string
): AnimationTimeline {
  return {
    ...timeline,
    cels: {
      ...timeline.cels,
      [frame]: layerId,
    },
  };
}

/**
 * Removes a cel mapping from a specific frame.
 */
export function removeFrameCel(
  timeline: AnimationTimeline,
  frame: number
): AnimationTimeline {
  const newCels = { ...timeline.cels };
  delete newCels[frame];
  return {
    ...timeline,
    cels: newCels,
  };
}

/**
 * Calculates prior and upcoming onion skin frames with progressive opacity falloff.
 */
export function getOnionSkinFrames(timeline: AnimationTimeline): OnionSkinFrameInfo[] {
  const { onionSkin, currentFrame, cels } = timeline;
  if (!onionSkin || !onionSkin.enabled) return [];

  const frames: OnionSkinFrameInfo[] = [];

  // Previous frames (Cyan / Red tint)
  const prevCount = Math.max(1, onionSkin.prevFrames || 2);
  for (let step = 1; step <= prevCount; step++) {
    const f = currentFrame - step;
    if (f >= 0 && cels[f]) {
      // Linear falloff: 1st prior frame gets 100% of base opacity, furthest gets lower
      const falloff = 1 - (step - 1) / prevCount;
      frames.push({
        frame: f,
        layerId: cels[f],
        tint: onionSkin.prevTint || '#00bcd4',
        opacity: Math.max(0.05, onionSkin.opacity * falloff),
        direction: 'prev',
      });
    }
  }

  // Next frames (Magenta / Blue tint)
  const nextCount = Math.max(1, onionSkin.nextFrames || 2);
  for (let step = 1; step <= nextCount; step++) {
    const f = currentFrame + step;
    if (f < timeline.totalFrames && cels[f]) {
      const falloff = 1 - (step - 1) / nextCount;
      frames.push({
        frame: f,
        layerId: cels[f],
        tint: onionSkin.nextTint || '#ec4899',
        opacity: Math.max(0.05, onionSkin.opacity * falloff),
        direction: 'next',
      });
    }
  }

  return frames;
}

/**
 * Renders an offscreen canvas tinted with a given hex color.
 */
export function renderTintedCanvas(
  sourceCanvas: HTMLCanvasElement,
  tintColorHex: string,
  opacity: number
): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = sourceCanvas.width;
  canvas.height = sourceCanvas.height;
  const ctx = canvas.getContext('2d');
  if (!ctx) return canvas;

  ctx.globalAlpha = opacity;
  ctx.drawImage(sourceCanvas, 0, 0);

  // Tint using source-in compositing
  ctx.globalCompositeOperation = 'source-in';
  ctx.fillStyle = tintColorHex;
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  return canvas;
}

/**
 * Composites a single animation frame onto an offscreen canvas.
 * Renders background layers, optional colored onion skinning, active cel, and foreground layers.
 */
export function renderAnimationFrame(
  frameIndex: number,
  timeline: AnimationTimeline,
  layers: LayerItem[],
  layerCanvases: Map<string, HTMLCanvasElement>,
  dimensions: { width: number; height: number },
  includeOnionSkin: boolean = false
): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = dimensions.width;
  canvas.height = dimensions.height;
  const ctx = canvas.getContext('2d');
  if (!ctx) return canvas;

  // Clear canvas
  ctx.clearRect(0, 0, dimensions.width, dimensions.height);

  const activeCelLayerId = timeline.cels[frameIndex];
  const allCelLayerIds = new Set(Object.values(timeline.cels));

  // Helper to check parent folder visibility and effective opacity
  const isEffectivelyVisible = (l: LayerItem): boolean => {
    if (!l.visible) return false;
    if (!l.parentId) return true;
    const p = layers.find((item) => item.id === l.parentId);
    return p ? isEffectivelyVisible(p) : true;
  };
  const getEffOpacity = (l: LayerItem): number => {
    if (!l.parentId) return l.opacity;
    const p = layers.find((item) => item.id === l.parentId);
    return p ? l.opacity * getEffOpacity(p) : l.opacity;
  };

  let renderedOnionSkins = false;

  // Render layers in true bottom-to-top stack order
  for (let i = layers.length - 1; i >= 0; i--) {
    const layer = layers[i];
    if (layer.type === 'folder') continue;
    if (!isEffectivelyVisible(layer)) continue;

    if (allCelLayerIds.has(layer.id)) {
      if (layer.id === activeCelLayerId) {
        if (!renderedOnionSkins && includeOnionSkin && timeline.onionSkin.enabled) {
          renderedOnionSkins = true;
          const onionFrames = getOnionSkinFrames({
            ...timeline,
            currentFrame: frameIndex,
          });
          for (const info of onionFrames) {
            const oc = layerCanvases.get(info.layerId);
            if (oc) {
              const tinted = renderTintedCanvas(oc, info.tint, info.opacity);
              ctx.save?.();
              ctx.globalAlpha = 1.0;
              ctx.globalCompositeOperation = 'source-over';
              ctx.drawImage(tinted, 0, 0);
              ctx.restore?.();
            }
          }
        }
        const celCanvas = layerCanvases.get(activeCelLayerId);
        if (celCanvas) {
          ctx.save?.();
          ctx.globalAlpha = getEffOpacity(layer);
          ctx.globalCompositeOperation = (layer.blendMode === 'normal' || layer.blendMode === 'pass-through') ? 'source-over' : (layer.blendMode as GlobalCompositeOperation);
          ctx.drawImage(celCanvas, 0, 0);
          ctx.globalAlpha = 1.0;
          ctx.globalCompositeOperation = 'source-over';
          ctx.restore?.();
        }
      }
      continue;
    }

    const c = layerCanvases.get(layer.id);
    if (c) {
      ctx.save?.();
      ctx.globalAlpha = getEffOpacity(layer);
      ctx.globalCompositeOperation = (layer.blendMode === 'normal' || layer.blendMode === 'pass-through') ? 'source-over' : (layer.blendMode as GlobalCompositeOperation);
      ctx.drawImage(c, 0, 0);
      ctx.globalAlpha = 1.0;
      ctx.globalCompositeOperation = 'source-over';
      ctx.restore?.();
    }
  }

  // If onion skin was requested and active frame had no cel layer in stack, still render onion skin
  if (!renderedOnionSkins && includeOnionSkin && timeline.onionSkin.enabled) {
    const onionFrames = getOnionSkinFrames({
      ...timeline,
      currentFrame: frameIndex,
    });
    for (const info of onionFrames) {
      const c = layerCanvases.get(info.layerId);
      if (c) {
        const tinted = renderTintedCanvas(c, info.tint, info.opacity);
        ctx.save?.();
        ctx.globalAlpha = 1.0;
        ctx.drawImage(tinted, 0, 0);
        ctx.restore?.();
      }
    }
  }

  return canvas;
}

/**
 * Downloads a Blob directly to the client's filesystem.
 */
export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

/**
 * Export Pipeline: Exports animation as a zipped numbered PNG sequence.
 */
export async function exportAnimationToPngZip(
  timeline: AnimationTimeline,
  layers: LayerItem[],
  layerCanvases: Map<string, HTMLCanvasElement>,
  dimensions: { width: number; height: number },
  onProgress?: (current: number, total: number) => void
): Promise<Blob> {
  const files: Record<string, Uint8Array> = {};
  const total = timeline.totalFrames;

  for (let f = 0; f < total; f++) {
    onProgress?.(f + 1, total);
    const frameCanvas = renderAnimationFrame(f, timeline, layers, layerCanvases, dimensions, false);

    // Convert canvas to PNG bytes via DataURL
    const dataUrl = frameCanvas.toDataURL('image/png');
    const base64Data = dataUrl.split(',')[1];
    const binaryStr = atob(base64Data);
    const bytes = new Uint8Array(binaryStr.length);
    for (let i = 0; i < binaryStr.length; i++) {
      bytes[i] = binaryStr.charCodeAt(i);
    }

    const pad = String(f + 1).padStart(4, '0');
    files[`frame_${pad}.png`] = bytes;
  }

  const zipped = zipSync(files, { level: 6 });
  return new Blob([zipped as any], { type: 'application/zip' });
}

/**
 * Export Pipeline: Exports animation to WebM or MP4 video using canvas.captureStream and MediaRecorder.
 */
export async function exportAnimationToVideo(
  timeline: AnimationTimeline,
  layers: LayerItem[],
  layerCanvases: Map<string, HTMLCanvasElement>,
  dimensions: { width: number; height: number },
  onProgress?: (current: number, total: number) => void
): Promise<Blob> {
  const { fps, totalFrames } = timeline;

  const canvas = document.createElement('canvas');
  canvas.width = dimensions.width;
  canvas.height = dimensions.height;
  const ctx = canvas.getContext('2d')!;

  const stream = canvas.captureStream(fps);

  const preferredTypes = [
    'video/webm;codecs=vp9',
    'video/webm;codecs=vp8',
    'video/webm',
    'video/mp4',
  ];
  const mimeType = preferredTypes.find((t) => MediaRecorder.isTypeSupported(t)) || 'video/webm';

  const recorder = new MediaRecorder(stream, {
    mimeType,
    videoBitsPerSecond: 8000000,
  });

  const chunks: Blob[] = [];
  recorder.ondataavailable = (e) => {
    if (e.data && e.data.size > 0) chunks.push(e.data);
  };

  const delayMs = 1000 / fps;

  return new Promise<Blob>((resolve, reject) => {
    recorder.onstop = () => {
      const blob = new Blob(chunks, { type: mimeType });
      resolve(blob);
    };
    recorder.onerror = (e) => reject(e);

    recorder.start();

    let frame = 0;
    const renderNext = () => {
      if (frame >= totalFrames) {
        recorder.stop();
        return;
      }

      onProgress?.(frame + 1, totalFrames);
      const frameCanvas = renderAnimationFrame(frame, timeline, layers, layerCanvases, dimensions, false);
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(frameCanvas, 0, 0);

      frame++;
      setTimeout(renderNext, delayMs);
    };

    renderNext();
  });
}

/**
 * Fast Client-Side Animated GIF89a Encoder with LZW compression and Netscape loop block.
 */
export async function exportAnimationToGif(
  timeline: AnimationTimeline,
  layers: LayerItem[],
  layerCanvases: Map<string, HTMLCanvasElement>,
  dimensions: { width: number; height: number },
  onProgress?: (current: number, total: number) => void
): Promise<Blob> {
  const { fps, totalFrames } = timeline;
  const width = Math.min(1280, dimensions.width);
  const height = Math.round((width / dimensions.width) * dimensions.height);

  const delayCentisecs = Math.max(2, Math.round(100 / fps));
  const buffer: number[] = [];

  // GIF Header
  for (const c of 'GIF89a') buffer.push(c.charCodeAt(0));

  // Logical Screen Descriptor
  buffer.push(width & 0xff, (width >> 8) & 0xff);
  buffer.push(height & 0xff, (height >> 8) & 0xff);
  buffer.push(0x70, 0x00, 0x00); // 128 colors, no global color table

  // Netscape 2.0 Loop Block
  buffer.push(0x21, 0xff, 0x0b);
  for (const c of 'NETSCAPE2.0') buffer.push(c.charCodeAt(0));
  buffer.push(0x03, 0x01, 0x00, 0x00, 0x00);

  const renderCanvas = document.createElement('canvas');
  renderCanvas.width = width;
  renderCanvas.height = height;
  const rCtx = renderCanvas.getContext('2d')!;

  for (let f = 0; f < totalFrames; f++) {
    onProgress?.(f + 1, totalFrames);
    const fullCanvas = renderAnimationFrame(f, timeline, layers, layerCanvases, dimensions, false);

    rCtx.clearRect(0, 0, width, height);
    rCtx.drawImage(fullCanvas, 0, 0, width, height);
    const imgData = rCtx.getImageData(0, 0, width, height);
    const pixels = imgData.data;

    // Build adaptive 64-color palette for fast encoding
    const palette: number[][] = [];
    const colorMap = new Map<number, number>();
    const indexedPixels = new Uint8Array(width * height);

    for (let i = 0; i < width * height; i++) {
      const r = pixels[i * 4] & 0xe0;
      const g = pixels[i * 4 + 1] & 0xe0;
      const b = pixels[i * 4 + 2] & 0xc0;
      const a = pixels[i * 4 + 3];

      if (a < 128) {
        indexedPixels[i] = 0; // Transparent
        continue;
      }

      const key = (r << 16) | (g << 8) | b;
      let colorIdx = colorMap.get(key);
      if (colorIdx === undefined) {
        if (palette.length < 127) {
          colorIdx = palette.length + 1;
          palette.push([r, g, b]);
          colorMap.set(key, colorIdx);
        } else {
          colorIdx = 1; // Fallback
        }
      }
      indexedPixels[i] = colorIdx;
    }

    // Graphic Control Extension (delay and transparent index 0)
    buffer.push(0x21, 0xf9, 0x04, 0x09);
    buffer.push(delayCentisecs & 0xff, (delayCentisecs >> 8) & 0xff);
    buffer.push(0x00, 0x00); // Transparent color index 0

    // Image Descriptor
    buffer.push(0x2c, 0x00, 0x00, 0x00, 0x00);
    buffer.push(width & 0xff, (width >> 8) & 0xff);
    buffer.push(height & 0xff, (height >> 8) & 0xff);
    buffer.push(0x86); // Local color table, 128 entries (7-bit)

    // Local Color Table
    buffer.push(0, 0, 0); // Transparent
    for (let i = 0; i < 127; i++) {
      if (i < palette.length) {
        buffer.push(palette[i][0], palette[i][1], palette[i][2]);
      } else {
        buffer.push(0, 0, 0);
      }
    }

    // Uncompressed LZW raster data
    const minCodeSize = 7;
    buffer.push(minCodeSize);

    let offset = 0;
    while (offset < indexedPixels.length) {
      // Max 125 literals per Clear Code so 8-bit LZW dictionary (129 + 125 = 254 < 256) never overflows into 9-bit codes
      const blockSize = Math.min(125, indexedPixels.length - offset);
      buffer.push(blockSize + 1);
      buffer.push(1 << minCodeSize); // Clear code
      for (let j = 0; j < blockSize; j++) {
        buffer.push(indexedPixels[offset + j]);
      }
      offset += blockSize;
    }
    buffer.push(0x01, (1 << minCodeSize) + 1); // End of information code
    buffer.push(0x00); // Block terminator
  }

  // GIF Trailer
  buffer.push(0x3b);

  return new Blob([new Uint8Array(buffer)], { type: 'image/gif' });
}

/**
 * Exports animation as an Animated PNG (APNG).
 */
export async function exportAnimationToApng(
  timeline: AnimationTimeline,
  layers: LayerItem[],
  layerCanvases: Map<string, HTMLCanvasElement>,
  dimensions: { width: number; height: number },
  onProgress?: (current: number, total: number) => void
): Promise<Blob> {
  const { fps, totalFrames } = timeline;
  const numFrames = totalFrames;

  // Render all frames to PNG array buffers
  const framePngBuffers: ArrayBuffer[] = [];
  for (let f = 0; f < numFrames; f++) {
    onProgress?.(f + 1, numFrames);
    const canvas = renderAnimationFrame(f, timeline, layers, layerCanvases, dimensions, false);
    const dataUrl = canvas.toDataURL('image/png');
    const base64 = dataUrl.split(',')[1];
    const binStr = atob(base64);
    const buf = new Uint8Array(binStr.length);
    for (let i = 0; i < binStr.length; i++) buf[i] = binStr.charCodeAt(i);
    framePngBuffers.push(buf.buffer);
  }

  // Helper CRC32 table
  const crcTable = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crcTable[n] = c;
  }
  const computeCrc = (type: string, data: Uint8Array): number => {
    let crc = 0xffffffff;
    for (let i = 0; i < 4; i++) crc = crcTable[(crc ^ type.charCodeAt(i)) & 0xff] ^ (crc >>> 8);
    for (let i = 0; i < data.length; i++) crc = crcTable[(crc ^ data[i]) & 0xff] ^ (crc >>> 8);
    return (crc ^ 0xffffffff) >>> 0;
  };

  const createChunk = (type: string, data: Uint8Array): Uint8Array => {
    const chunk = new Uint8Array(4 + 4 + data.length + 4);
    const dv = new DataView(chunk.buffer);
    dv.setUint32(0, data.length);
    for (let i = 0; i < 4; i++) chunk[4 + i] = type.charCodeAt(i);
    chunk.set(data, 8);
    dv.setUint32(8 + data.length, computeCrc(type, data));
    return chunk;
  };

  // Parse chunks from first frame
  const f0 = new Uint8Array(framePngBuffers[0]);
  let offset = 8; // skip 8-byte signature
  let ihdrChunk: Uint8Array | null = null;
  const idatChunks: Uint8Array[] = [];

  while (offset < f0.length) {
    const len = new DataView(f0.buffer, offset, 4).getUint32(0);
    const type = String.fromCharCode(...f0.slice(offset + 4, offset + 8));
    const fullLen = 8 + len + 4;
    const chunkData = f0.slice(offset, offset + fullLen);

    if (type === 'IHDR') ihdrChunk = chunkData;
    else if (type === 'IDAT') idatChunks.push(f0.slice(offset + 8, offset + 8 + len));
    offset += fullLen;
  }

  const outChunks: Uint8Array[] = [];
  // PNG Signature
  outChunks.push(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  if (ihdrChunk) outChunks.push(ihdrChunk);

  // acTL chunk (num_frames: 4 bytes, num_plays: 4 bytes: 0 for infinite loop, 1 for once)
  const actlData = new Uint8Array(8);
  const actlDv = new DataView(actlData.buffer);
  actlDv.setUint32(0, numFrames);
  actlDv.setUint32(4, timeline.loop === false ? 1 : 0);
  outChunks.push(createChunk('acTL', actlData));

  let seq = 0;

  // Frame 0: fcTL + IDATs
  const fctl0 = new Uint8Array(26);
  const fctl0Dv = new DataView(fctl0.buffer);
  fctl0Dv.setUint32(0, seq++);
  fctl0Dv.setUint32(4, dimensions.width);
  fctl0Dv.setUint32(8, dimensions.height);
  fctl0Dv.setUint32(12, 0); // x offset
  fctl0Dv.setUint32(16, 0); // y offset
  fctl0Dv.setUint16(20, 1); // delay num
  fctl0Dv.setUint16(22, fps); // delay den
  fctl0Dv.setUint8(24, 0); // dispose op (none)
  fctl0Dv.setUint8(25, 0); // blend op (source)
  outChunks.push(createChunk('fcTL', fctl0));

  for (const idat of idatChunks) {
    outChunks.push(createChunk('IDAT', idat));
  }

  // Frames 1..N-1: fcTL + fdATs
  for (let f = 1; f < numFrames; f++) {
    const fnBytes = new Uint8Array(framePngBuffers[f]);
    let fOffset = 8;
    const fnIdats: Uint8Array[] = [];

    while (fOffset < fnBytes.length) {
      const len = new DataView(fnBytes.buffer, fOffset, 4).getUint32(0);
      const type = String.fromCharCode(...fnBytes.slice(fOffset + 4, fOffset + 8));
      if (type === 'IDAT') {
        fnIdats.push(fnBytes.slice(fOffset + 8, fOffset + 8 + len));
      }
      fOffset += 8 + len + 4;
    }

    const fctl = new Uint8Array(26);
    const fctlDv = new DataView(fctl.buffer);
    fctlDv.setUint32(0, seq++);
    fctlDv.setUint32(4, dimensions.width);
    fctlDv.setUint32(8, dimensions.height);
    fctlDv.setUint32(12, 0);
    fctlDv.setUint32(16, 0);
    fctlDv.setUint16(20, 1);
    fctlDv.setUint16(22, fps);
    fctlDv.setUint8(24, 0);
    fctlDv.setUint8(25, 0);
    outChunks.push(createChunk('fcTL', fctl));

    for (const idat of fnIdats) {
      const fdat = new Uint8Array(4 + idat.length);
      new DataView(fdat.buffer).setUint32(0, seq++);
      fdat.set(idat, 4);
      outChunks.push(createChunk('fdAT', fdat));
    }
  }

  // IEND chunk
  outChunks.push(createChunk('IEND', new Uint8Array(0)));

  const totalLen = outChunks.reduce((acc, c) => acc + c.length, 0);
  const apngBytes = new Uint8Array(totalLen);
  let p = 0;
  for (const c of outChunks) {
    apngBytes.set(c, p);
    p += c.length;
  }

  return new Blob([apngBytes], { type: 'image/png' });
}
