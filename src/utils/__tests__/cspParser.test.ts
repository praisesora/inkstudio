import { describe, it, expect, afterEach } from 'vitest';
import { zlibSync } from 'fflate';
import {
  mapCspBlendMode,
  parseCspChunks,
  extractExtaChunks,
  parseOffscreenAttribute,
  parseBlockDataPayload,
  decodeCspTileToRgba,
  parseCspFile,
} from '../cspParser';
import { hydrateParsedDocumentBinary } from '../nativeBackend';
import { unpackTabletSampleBatch } from '../nativeTabletInput';
import { lz4CompressBlock } from '../lz4';
import { BYTES_32BIT, TILE_PIXELS, TILE_SIZE } from '../tileEngine';

function concatBytes(parts: Uint8Array[]): Uint8Array {
  let total = 0;
  for (const p of parts) total += p.byteLength;
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.byteLength;
  }
  return out;
}

function u32BE(val: number): Uint8Array {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setUint32(0, val >>> 0, false);
  return b;
}

function u32LE(val: number): Uint8Array {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setUint32(0, val >>> 0, true);
  return b;
}

function u64BE(val: number): Uint8Array {
  const b = new Uint8Array(8);
  const view = new DataView(b.buffer);
  view.setUint32(0, Math.floor(val / 0x100000000), false);
  view.setUint32(4, val >>> 0, false);
  return b;
}

function asciiBytes(s: string): Uint8Array {
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i) & 0xff;
  return out;
}

function utf16BeTagged(s: string): Uint8Array {
  const out = new Uint8Array(4 + s.length * 2);
  new DataView(out.buffer).setUint32(0, s.length, false);
  for (let i = 0; i < s.length; i++) {
    out[4 + i * 2] = 0;
    out[4 + i * 2 + 1] = s.charCodeAt(i) & 0xff;
  }
  return out;
}

function buildOffscreenAttribute(
  bitmapW: number,
  bitmapH: number,
  defaultFill: number = 0,
  ch1: number = 1,
  ch2: number = 4
): Uint8Array {
  const gw = Math.ceil(bitmapW / TILE_SIZE);
  const gh = Math.ceil(bitmapH / TILE_SIZE);
  return concatBytes([
    u32BE(88),
    utf16BeTagged('Parameter'),
    u32BE(bitmapW),
    u32BE(bitmapH),
    u32BE(gw),
    u32BE(gh),
    u32BE(defaultFill),
    u32BE(0),
    u32BE(ch1),
    u32BE(ch2),
    u32BE(0),
    u32BE(0),
    u32BE(0),
    u32BE(0),
    u32BE(0),
    u32BE(8),
  ]);
}

function buildBlockData(tileBuffers: Array<Uint8Array | null>): Uint8Array {
  const beginTag = utf16BeTagged('BlockDataBeginChunk');
  const endTag = utf16BeTagged('BlockDataEndChunk');
  const parts: Uint8Array[] = [];

  for (let idx = 0; idx < tileBuffers.length; idx++) {
    const raw = tileBuffers[idx];
    parts.push(beginTag);
    if (!raw) {
      parts.push(u32BE(idx), u32BE(0), u32BE(0), u32BE(0), u32BE(0));
    } else {
      const z = zlibSync(raw, { level: 1 });
      const subBlock = concatBytes([u32BE(4 + z.byteLength), u32LE(raw.byteLength), z]);
      parts.push(u32BE(idx), u32BE(0), u32BE(0), u32BE(0), u32BE(1), subBlock);
    }
    parts.push(endTag);
  }
  return concatBytes(parts);
}

function buildExtaChunk(externalId: string, payload: Uint8Array, withPayloadLen = true): Uint8Array {
  const idBytes = asciiBytes(externalId);
  const data = withPayloadLen
    ? concatBytes([u64BE(idBytes.byteLength), idBytes, u64BE(payload.byteLength), payload])
    : concatBytes([u64BE(idBytes.byteLength), idBytes, payload]);
  return concatBytes([asciiBytes('CHNK'), asciiBytes('Exta'), u64BE(data.byteLength), data]);
}

function buildClipFile(chunks: Uint8Array[]): ArrayBuffer {
  const header = concatBytes([asciiBytes('CSFCHUNK'), new Uint8Array(16)]);
  const foot = concatBytes([asciiBytes('CHNK'), asciiBytes('Foot'), u64BE(0)]);
  const merged = concatBytes([header, ...chunks, foot]);
  const ab = new ArrayBuffer(merged.byteLength);
  new Uint8Array(ab).set(merged);
  return ab;
}

function makeColorTile(r: number, g: number, b: number, a: number): Uint8Array {
  const raw = new Uint8Array(TILE_PIXELS * 5);
  raw.fill(a, 0, TILE_PIXELS);
  for (let p = 0; p < TILE_PIXELS; p++) {
    const ci = TILE_PIXELS + p * 4;
    raw[ci] = b;
    raw[ci + 1] = g;
    raw[ci + 2] = r;
    raw[ci + 3] = 0;
  }
  return raw;
}

describe('CSP (.clip) binary helpers & Rust INKD wire hydration (zero sql.js)', () => {
  const originalDocument = (globalThis as Record<string, unknown>).document;

  afterEach(() => {
    if (originalDocument === undefined) {
      delete (globalThis as Record<string, unknown>).document;
    } else {
      (globalThis as Record<string, unknown>).document = originalDocument;
    }
  });

  it('maps CSP composite blend mode integers accurately', () => {
    expect(mapCspBlendMode(0)).toBe('normal');
    expect(mapCspBlendMode(1)).toBe('darken');
    expect(mapCspBlendMode(2)).toBe('multiply');
    expect(mapCspBlendMode(3)).toBe('color-burn');
    expect(mapCspBlendMode(4)).toBe('linear-burn');
    expect(mapCspBlendMode(5)).toBe('subtract');
    expect(mapCspBlendMode(6)).toBe('darker-color');
    expect(mapCspBlendMode(7)).toBe('lighten');
    expect(mapCspBlendMode(8)).toBe('screen');
    expect(mapCspBlendMode(9)).toBe('color-dodge');
    expect(mapCspBlendMode(10)).toBe('color-dodge-glow');
    expect(mapCspBlendMode(12)).toBe('add-glow');
    expect(mapCspBlendMode(13)).toBe('lighter-color');
    expect(mapCspBlendMode(14)).toBe('overlay');
    expect(mapCspBlendMode(15)).toBe('soft-light');
    expect(mapCspBlendMode(16)).toBe('hard-light');
    expect(mapCspBlendMode(17)).toBe('vivid-light');
    expect(mapCspBlendMode(18)).toBe('linear-light');
    expect(mapCspBlendMode(19)).toBe('pin-light');
    expect(mapCspBlendMode(20)).toBe('hard-mix');
    expect(mapCspBlendMode(21)).toBe('difference');
    expect(mapCspBlendMode(22)).toBe('exclusion');
    expect(mapCspBlendMode(23)).toBe('hue');
    expect(mapCspBlendMode(24)).toBe('saturation');
    expect(mapCspBlendMode(25)).toBe('color');
    expect(mapCspBlendMode(26)).toBe('luminosity');
    expect(mapCspBlendMode(30)).toBe('pass-through');
    expect(mapCspBlendMode(36)).toBe('divide');
  });

  it('parses CSFCHUNK, CHNKExta, Offscreen.Attribute, and BlockData tiles', () => {
    const attrBlob = buildOffscreenAttribute(512, 300, 1, 1, 4);
    const parsed = parseOffscreenAttribute(attrBlob, 100, 100);
    expect(parsed.bitmapWidth).toBe(512);
    expect(parsed.bitmapHeight).toBe(300);
    expect(parsed.blockGridWidth).toBe(2);
    expect(parsed.blockGridHeight).toBe(2);
    expect(parsed.defaultFill).toBe(1);

    const tile = makeColorTile(240, 20, 10, 200);
    const blockData = buildBlockData([null, tile]);
    const buf = buildClipFile([
      buildExtaChunk('extrnlid_withlen', blockData, true),
      buildExtaChunk('extrnlid_nolen', blockData, false),
    ]);
    const chunks = parseCspChunks(new Uint8Array(buf));
    const exta = extractExtaChunks(chunks);

    expect(exta.has('extrnlid_withlen')).toBe(true);
    expect(exta.has('extrnlid_nolen')).toBe(true);

    const decoded = parseBlockDataPayload(exta.get('extrnlid_withlen')!, 2);
    expect(decoded.has(0)).toBe(false);
    expect(decoded.has(1)).toBe(true);

    const rgba = new Uint8ClampedArray(BYTES_32BIT);
    expect(decodeCspTileToRgba(decoded.get(1)!, rgba, parsed)).toBe(true);
    expect([rgba[0], rgba[1], rgba[2], rgba[3]]).toEqual([240, 20, 10, 200]);
  });

  it('hydrates Rust INKD binary payload into SparseTileGrid with LZ4 tiles, folders, and paper', () => {
    const rawTile = new Uint8Array(BYTES_32BIT);
    const px = (5 * TILE_SIZE + 3) * 4;
    rawTile[px] = 220;
    rawTile[px + 1] = 30;
    rawTile[px + 2] = 40;
    rawTile[px + 3] = 255;
    const compTile = lz4CompressBlock(rawTile);

    const meta = {
      width: 512,
      height: 256,
      dpi: 600,
      colorMode: 'color',
      preview: null,
      layers: [
        {
          id: 'csp-folder-1',
          name: 'Paint',
          type: 'folder',
          visible: true,
          opacity: 1,
          blendMode: 'pass-through',
          locked: false,
          alphaLocked: false,
          clipped: false,
          collapsed: true,
          parentId: null,
          solidFillHex: null,
          tiles: [],
          mask: null,
        },
        {
          id: 'csp-layer-2',
          name: 'Ink',
          type: 'raster',
          visible: true,
          opacity: 0.5,
          blendMode: 'multiply',
          locked: false,
          alphaLocked: true,
          clipped: true,
          collapsed: false,
          parentId: 'csp-folder-1',
          solidFillHex: null,
          tiles: [{ tx: 1, ty: 0, codec: 2, offset: 0, len: compTile.byteLength }],
          mask: null,
        },
        {
          id: 'csp-layer-3',
          name: 'Paper',
          type: 'raster',
          visible: true,
          opacity: 1,
          blendMode: 'normal',
          locked: false,
          alphaLocked: false,
          clipped: false,
          collapsed: false,
          parentId: null,
          solidFillHex: '#ffffff',
          tiles: [],
          mask: null,
        },
      ],
    };

    const metaBytes = new TextEncoder().encode(JSON.stringify(meta));
    const wire = concatBytes([asciiBytes('INKD'), u32LE(1), u32LE(metaBytes.byteLength), metaBytes, compTile]);

    const doc = hydrateParsedDocumentBinary(wire, 'manga.clip');
    expect(doc.dimensions).toEqual({ width: 512, height: 256, dpi: 600 });
    expect(doc.layers).toHaveLength(3);
    expect(doc.layers[0].type).toBe('folder');
    expect(doc.layers[0].collapsed).toBe(true);
    expect(doc.layers[1].parentId).toBe(doc.layers[0].id);
    expect(doc.layers[1].blendMode).toBe('multiply');
    expect(doc.layers[1].alphaLocked).toBe(true);

    expect(doc.tileGrid).toBeDefined();
    const readBack = doc.tileGrid!.readImageData(doc.layers[1].id, 256 + 3, 5, 1, 1);
    expect(Array.from(readBack.data)).toEqual([220, 30, 40, 255]);

    const paperPx = doc.tileGrid!.readImageData(doc.layers[2].id, 0, 0, 1, 1);
    expect(Array.from(paperPx.data)).toEqual([255, 255, 255, 255]);
  });

  it('rejects .clip parsing gracefully outside Tauri (WASM sql.js removed)', async () => {
    await expect(parseCspFile(new ArrayBuffer(16), 'test.clip')).rejects.toThrow(/Rust backend/);
  });

  it('unpacks binary native tablet sample packets matching Rust layout', () => {
    const buf = new ArrayBuffer(4 + 36);
    const v = new DataView(buf);
    v.setUint32(0, 1, true);
    v.setFloat32(4, 123.5, true);
    v.setFloat32(8, 456.25, true);
    v.setFloat32(12, 0.75, true);
    v.setFloat32(16, -15.0, true);
    v.setFloat32(20, 30.0, true);
    v.setFloat32(24, 90.0, true);
    v.setFloat64(28, 123456.789, true);
    v.setUint16(36, 9, true);
    v.setUint8(38, 2);
    v.setUint8(39, 1);

    const samples = unpackTabletSampleBatch(buf);
    expect(samples).toHaveLength(1);
    expect(samples[0]).toEqual({
      clientX: 123.5,
      clientY: 456.25,
      pressure: 0.75,
      tiltX: -15.0,
      tiltY: 30.0,
      twist: 90.0,
      timestamp: 123456.789,
      buttons: 9,
      phase: 2,
      backend: 1,
    });
  });
});
