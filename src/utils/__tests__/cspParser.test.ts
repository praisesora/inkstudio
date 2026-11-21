import { describe, it, expect, afterEach } from 'vitest';
import initSqlJs from 'sql.js';
import { zlibSync } from 'fflate';
import {
  mapCspBlendMode,
  parseCspChunks,
  extractExtaChunks,
  parseOffscreenAttribute,
  parseBlockDataPayload,
  parseCspFile,
} from '../cspParser';
import { TILE_PIXELS, TILE_SIZE } from '../tileEngine';

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

function buildBlockData(blocks: Array<Uint8Array | Uint8Array[] | null>): Uint8Array {
  const parts: Uint8Array[] = [];
  for (let idx = 0; idx < blocks.length; idx++) {
    const entry = blocks[idx];
    const beginTag = utf16BeTagged('BlockDataBeginChunk');
    const endTag = utf16BeTagged('BlockDataEndChunk');
    if (entry === null) {
      const inner = concatBytes([
        beginTag,
        u32BE(idx),
        u32BE(0),
        u32BE(256),
        u32BE(256),
        u32BE(0), // empty block
        endTag,
      ]);
      parts.push(u32BE(inner.byteLength), inner);
    } else {
      const planes = Array.isArray(entry) ? entry : [entry];
      const subChunks = planes.map((plane) => {
        const compressed = zlibSync(plane);
        const outerLen = 4 + compressed.byteLength;
        return concatBytes([u32BE(outerLen), u32LE(compressed.byteLength), compressed]);
      });
      const inner = concatBytes([
        beginTag,
        u32BE(idx),
        u32BE(0),
        u32BE(256),
        u32BE(256),
        u32BE(1), // hasData
        ...subChunks,
        endTag,
      ]);
      parts.push(u32BE(inner.byteLength), inner);
    }
  }
  return concatBytes(parts);
}

function buildChunk(name: string, payload: Uint8Array): Uint8Array {
  return concatBytes([asciiBytes('CHNK'), asciiBytes(name), u64BE(payload.byteLength), payload]);
}

function buildExtaChunk(externalId: string, payload: Uint8Array, includePayloadLen = true): Uint8Array {
  const idBytes = asciiBytes(externalId);
  const body = includePayloadLen
    ? concatBytes([u64BE(idBytes.byteLength), idBytes, u64BE(payload.byteLength), payload])
    : concatBytes([u64BE(idBytes.byteLength), idBytes, payload]);
  return buildChunk('Exta', body);
}

function buildClipFile(chunks: Uint8Array[]): ArrayBuffer {
  const body = concatBytes([...chunks, buildChunk('Foot', new Uint8Array(0))]);
  const totalSize = 24 + body.byteLength;
  const header = concatBytes([asciiBytes('CSFCHUNK'), u64BE(totalSize), u64BE(24)]);
  const full = concatBytes([header, body]);
  const out = new ArrayBuffer(full.byteLength);
  new Uint8Array(out).set(full);
  return out;
}

function makeColorTile(r: number, g: number, b: number, a: number): Uint8Array {
  const raw = new Uint8Array(TILE_PIXELS * 5);
  raw.fill(a, 0, TILE_PIXELS);
  for (let p = 0; p < TILE_PIXELS; p++) {
    const off = TILE_PIXELS + p * 4;
    raw[off] = b;
    raw[off + 1] = g;
    raw[off + 2] = r;
    raw[off + 3] = 0;
  }
  return raw;
}

function createPixelCanvas(width: number, height: number) {
  let w = width;
  let h = height;
  let pixels = new Uint8ClampedArray(w * h * 4);
  const ctx = {
    createImageData(iw: number, ih: number) {
      return { data: new Uint8ClampedArray(iw * ih * 4), width: iw, height: ih };
    },
    putImageData(img: { data: Uint8ClampedArray; width: number; height: number }, dx: number, dy: number) {
      for (let y = 0; y < img.height; y++) {
        const ty = dy + y;
        if (ty < 0 || ty >= h) continue;
        for (let x = 0; x < img.width; x++) {
          const tx = dx + x;
          if (tx < 0 || tx >= w) continue;
          const si = (y * img.width + x) * 4;
          const di = (ty * w + tx) * 4;
          pixels[di] = img.data[si];
          pixels[di + 1] = img.data[si + 1];
          pixels[di + 2] = img.data[si + 2];
          pixels[di + 3] = img.data[si + 3];
        }
      }
    },
    getImageData(sx: number, sy: number, sw: number, sh: number) {
      const out = new Uint8ClampedArray(sw * sh * 4);
      for (let y = 0; y < sh; y++) {
        const py = sy + y;
        if (py < 0 || py >= h) continue;
        for (let x = 0; x < sw; x++) {
          const px = sx + x;
          if (px < 0 || px >= w) continue;
          const si = (py * w + px) * 4;
          const di = (y * sw + x) * 4;
          out[di] = pixels[si];
          out[di + 1] = pixels[si + 1];
          out[di + 2] = pixels[si + 2];
          out[di + 3] = pixels[si + 3];
        }
      }
      return { data: out, width: sw, height: sh };
    },
    clearRect() {
      pixels.fill(0);
    },
    drawImage() {},
    fillRect() {},
  };
  return {
    get width() {
      return w;
    },
    set width(v: number) {
      w = v;
      pixels = new Uint8ClampedArray(Math.max(0, w) * Math.max(0, h) * 4);
    },
    get height() {
      return h;
    },
    set height(v: number) {
      h = v;
      pixels = new Uint8ClampedArray(Math.max(0, w) * Math.max(0, h) * 4);
    },
    getContext: (t: string) => (t === '2d' ? ctx : null),
    toDataURL: () => 'data:image/png;base64,MOCK',
  } as unknown as HTMLCanvasElement;
}

describe('Clip Studio Paint (.clip) Parser', () => {
  const prevDocument = (globalThis as Record<string, unknown>).document;

  afterEach(() => {
    if (prevDocument === undefined) {
      delete (globalThis as Record<string, unknown>).document;
    } else {
      (globalThis as Record<string, unknown>).document = prevDocument;
    }
  });

  it('maps CSP LayerComposite codes accurately to Ink Studio BlendMode', () => {
    expect(mapCspBlendMode(0)).toBe('normal');
    expect(mapCspBlendMode(1)).toBe('darken');
    expect(mapCspBlendMode(2)).toBe('multiply');
    expect(mapCspBlendMode(3)).toBe('color-burn');
    expect(mapCspBlendMode(4)).toBe('linear-burn');
    expect(mapCspBlendMode(7)).toBe('lighten');
    expect(mapCspBlendMode(8)).toBe('screen');
    expect(mapCspBlendMode(9)).toBe('color-dodge');
    expect(mapCspBlendMode(10)).toBe('color-dodge-glow');
    expect(mapCspBlendMode(12)).toBe('add-glow');
    expect(mapCspBlendMode(14)).toBe('overlay');
    expect(mapCspBlendMode(15)).toBe('soft-light');
    expect(mapCspBlendMode(16)).toBe('hard-light');
    expect(mapCspBlendMode(21)).toBe('difference');
    expect(mapCspBlendMode(22)).toBe('exclusion');
    expect(mapCspBlendMode(30)).toBe('pass-through');
    expect(mapCspBlendMode(36)).toBe('divide');
  });

  it('parses CSFCHUNK, CHNKExta (with and without payloadLen), and Offscreen.Attribute', () => {
    const attrBlob = buildOffscreenAttribute(512, 300, 1, 1, 4);
    const parsed = parseOffscreenAttribute(attrBlob, 100, 100);
    expect(parsed.bitmapWidth).toBe(512);
    expect(parsed.bitmapHeight).toBe(300);
    expect(parsed.blockGridWidth).toBe(2);
    expect(parsed.blockGridHeight).toBe(2);
    expect(parsed.defaultFill).toBe(1);
    expect(parsed.firstPackingChannels).toBe(1);
    expect(parsed.secondPackingChannels).toBe(4);

    const tile = makeColorTile(10, 20, 30, 255);
    const blockData = buildBlockData([null, tile]);
    const buf = buildClipFile([
      buildExtaChunk('extrnlid_withlen', blockData, true),
      buildExtaChunk('extrnlid_nolen', blockData, false),
    ]);
    const chunks = parseCspChunks(new Uint8Array(buf));
    const exta = extractExtaChunks(chunks);

    expect(exta.has('extrnlid_withlen')).toBe(true);
    expect(exta.has('extrnlid_nolen')).toBe(true);

    // Sparse tile index 1 must NOT collapse onto index 0!
    const decoded = parseBlockDataPayload(exta.get('extrnlid_withlen')!, 2);
    expect(decoded.has(0)).toBe(false);
    expect(decoded.has(1)).toBe(true);
    expect(decoded.get(1)!.byteLength).toBe(TILE_PIXELS * 5);
  });

  it('decodes full editable layer hierarchy, folders, sparse tiles, offsets, masks, grayscale, mono, and paper', async () => {
    (globalThis as Record<string, unknown>).document = {
      createElement: () => createPixelCanvas(512, 256),
    };

    const SQL = await initSqlJs();
    const db = new SQL.Database();

    db.run(`
      CREATE TABLE Canvas (MainId INTEGER, CanvasWidth INTEGER, CanvasHeight INTEGER, CanvasResolution REAL, CanvasRootFolder INTEGER);
      CREATE TABLE Layer (
        MainId INTEGER, LayerName TEXT, LayerType INTEGER, LayerFolder INTEGER,
        LayerComposite INTEGER, LayerOpacity INTEGER, LayerVisibility INTEGER,
        LayerLock INTEGER, LayerClip INTEGER, LayerSelect INTEGER,
        LayerOffsetX REAL, LayerOffsetY REAL, LayerMaskOffsetX REAL, LayerMaskOffsetY REAL,
        LayerNextIndex INTEGER, LayerFirstChildIndex INTEGER,
        LayerRenderMipmap INTEGER, LayerLayerMaskMipmap INTEGER
      );
      CREATE TABLE Mipmap (MainId INTEGER, BaseMipmapInfo INTEGER);
      CREATE TABLE MipmapInfo (MainId INTEGER, ThisScale REAL, Offscreen INTEGER, NextIndex INTEGER);
      CREATE TABLE Offscreen (MainId INTEGER, LayerId INTEGER, BlockData TEXT, Attribute BLOB);
    `);

    // Canvas: 512x256 @ 600 DPI, root folder = 1
    db.run('INSERT INTO Canvas VALUES (1, 512, 256, 600, 1)');

    // Root folder (MainId=1): children bottom-to-top: Paper(2) -> Lineart(3) -> PaintFolder(4)
    db.run('INSERT INTO Layer VALUES (1, "", 256, 1, 0, 256, 1, 0, 0, 0, 0, 0, 0, 0, 0, 2, 0, 0)');
    // Paper (MainId=2, bottom-most, no tiles -> solid white)
    db.run('INSERT INTO Layer VALUES (2, "Paper", 1, 0, 0, 256, 1, 0, 0, 0, 0, 0, 0, 0, 3, 0, 0, 0)');
    // Lineart (MainId=3, 1-bit monochrome, visible, opacity 256, alpha locked)
    db.run('INSERT INTO Layer VALUES (3, "Lineart", 1, 0, 2, 256, 1, 16, 0, 0, 0, 0, 0, 0, 4, 0, 10, 0)');
    // PaintFolder (MainId=4, collapsed=true (17=1|16), pass-through=30, children bottom-to-top: Base(5) -> Shadow(6))
    db.run('INSERT INTO Layer VALUES (4, "Paint", 256, 17, 30, 256, 1, 0, 0, 0, 0, 0, 0, 0, 0, 5, 0, 0)');
    // Base (MainId=5, color layer with sparse tile at col=1 + layer mask enabled & linked!)
    db.run('INSERT INTO Layer VALUES (5, "Base Color", 1, 0, 0, 256, 3, 0, 0, 256, 0, 0, 0, 0, 6, 0, 20, 21)');
    // Shadow (MainId=6, clipped to Base, Multiply, 50% opacity = 128, grayscale 2-plane)
    db.run('INSERT INTO Layer VALUES (6, "Shadow", 1, 0, 2, 128, 1, 0, 1, 0, 0, 0, 0, 0, 0, 0, 30, 0)');

    // Mipmap -> MipmapInfo -> Offscreen wiring (also include a 0.5x mipmap to verify 1.0x is chosen!)
    db.run('INSERT INTO Mipmap VALUES (10, 100), (20, 200), (21, 210), (30, 300)');
    db.run('INSERT INTO MipmapInfo VALUES (100, 1.0, 1000, 101), (101, 0.5, 1001, 0)');
    db.run('INSERT INTO MipmapInfo VALUES (200, 1.0, 2000, 0)');
    db.run('INSERT INTO MipmapInfo VALUES (210, 1.0, 2100, 0)');
    db.run('INSERT INTO MipmapInfo VALUES (300, 1.0, 3000, 0)');

    const attr512 = buildOffscreenAttribute(512, 256, 0, 1, 4);
    const attrMask = buildOffscreenAttribute(512, 256, 0, 0, 1);

    db.run('INSERT INTO Offscreen VALUES (1000, 3, "extrnlid_lineart", ?)', [attr512]);
    db.run('INSERT INTO Offscreen VALUES (1001, 3, "extrnlid_lineart_half", ?)', [buildOffscreenAttribute(256, 128, 0, 1, 1)]);
    db.run('INSERT INTO Offscreen VALUES (2000, 5, "extrnlid_base", ?)', [attr512]);
    db.run('INSERT INTO Offscreen VALUES (2100, 5, "extrnlid_mask", ?)', [attrMask]);
    db.run('INSERT INTO Offscreen VALUES (3000, 6, "extrnlid_shadow", ?)', [attr512]);

    const sqliteBytes = db.export();
    db.close();

    // Lineart: 1-bit monochrome tile at block 0, pixel (0,0) = black ink (MSB bit 7 of byte 0)
    const monoTile = new Uint8Array(8192);
    monoTile[0] = 0x80; // pixel (0, 0) drawn
    const lineartPayload = buildBlockData([monoTile, null]);

    // Base Color: sparse — block 0 is EMPTY (null), block 1 (x=256..511) is solid crimson (220, 40, 60, 255) split into 2 planes!
    const alphaPlane = new Uint8Array(TILE_PIXELS).fill(255);
    const bgrxPlane = new Uint8Array(TILE_PIXELS * 4);
    for (let p = 0; p < TILE_PIXELS; p++) {
      bgrxPlane[p * 4] = 60;      // B
      bgrxPlane[p * 4 + 1] = 40;  // G
      bgrxPlane[p * 4 + 2] = 220; // R
    }
    const basePayload = buildBlockData([null, [alphaPlane, bgrxPlane]]);

    // Mask for Base Color: block 0 empty (defaultFill=0 -> masked), block 1 = 200
    const maskTile = new Uint8Array(TILE_PIXELS).fill(200);
    const maskPayload = buildBlockData([null, maskTile]);

    // Shadow: grayscale 2-plane (alpha=180, gray=90) on block 0
    const grayTile = new Uint8Array(TILE_PIXELS * 2);
    grayTile.fill(180, 0, TILE_PIXELS);
    grayTile.fill(90, TILE_PIXELS, TILE_PIXELS * 2);
    const shadowPayload = buildBlockData([grayTile, null]);

    const clipBuf = buildClipFile([
      buildChunk('SQLi', sqliteBytes),
      buildExtaChunk('extrnlid_lineart', lineartPayload),
      buildExtaChunk('extrnlid_base', basePayload),
      buildExtaChunk('extrnlid_mask', maskPayload),
      buildExtaChunk('extrnlid_shadow', shadowPayload),
    ]);

    const doc = await parseCspFile(clipBuf, 'manga_page.clip');

    expect(doc.name).toBe('manga_page');
    expect(doc.dimensions).toEqual({ width: 512, height: 256, dpi: 600 });
    expect(doc.tileGrid).toBeDefined();

    // Expected top-to-bottom order: Paint (folder) -> Shadow -> Base Color -> Lineart -> Paper
    expect(doc.layers.map((l) => l.name)).toEqual([
      'Paint',
      'Shadow',
      'Base Color',
      'Lineart',
      'Paper',
    ]);

    const [paintFolder, shadowLayer, baseLayer, lineartLayer, paperLayer] = doc.layers;

    expect(paintFolder.type).toBe('folder');
    expect(paintFolder.collapsed).toBe(true);
    expect(paintFolder.blendMode).toBe('pass-through');
    expect(paintFolder.parentId).toBeNull();

    expect(shadowLayer.parentId).toBe(paintFolder.id);
    expect(shadowLayer.clipped).toBe(true);
    expect(shadowLayer.blendMode).toBe('multiply');
    expect(shadowLayer.opacity).toBeCloseTo(0.5, 2);

    expect(baseLayer.parentId).toBe(paintFolder.id);
    expect(baseLayer.maskEnabled).toBe(true);
    expect(baseLayer.maskLinked).toBe(true);
    expect(baseLayer.maskCanvas).toBeDefined();
    // Verify mask pixel: (10,10) = 0 (defaultFill), (260,10) = 200
    const mCtx = baseLayer.maskCanvas!.getContext('2d')!;
    expect(mCtx.getImageData(10, 10, 1, 1).data[0]).toBe(0);
    expect(mCtx.getImageData(260, 10, 1, 1).data[0]).toBe(200);

    expect(lineartLayer.alphaLocked).toBe(true);
    expect(lineartLayer.locked).toBe(false);
    expect(lineartLayer.blendMode).toBe('multiply');

    // Verify decoded pixels in SparseTileGrid!
    const grid = doc.tileGrid!;

    // Base Color: x=10 (tile 0) must be unallocated (empty); x=260 (tile 1) must be RGBA(220, 40, 60, 255)
    const baseTile0 = grid.getTile(baseLayer.id, 0, 0, 0);
    expect(baseTile0).toBeNull();
    const baseTile1 = grid.getTile(baseLayer.id, 1, 0, 0);
    expect(baseTile1?.data).toBeDefined();
    expect(Array.from(baseTile1!.data!.subarray(0, 4))).toEqual([220, 40, 60, 255]);

    // Lineart 1-bit monochrome: pixel (0,0) = black (0,0,0,255), pixel (1,0) = transparent
    const lineTile0 = grid.getTile(lineartLayer.id, 0, 0, 0);
    expect(Array.from(lineTile0!.data!.subarray(0, 4))).toEqual([0, 0, 0, 255]);
    expect(Array.from(lineTile0!.data!.subarray(4, 8))).toEqual([0, 0, 0, 0]);

    // Shadow grayscale: pixel (0,0) = (90, 90, 90, 180)
    const shadowTile0 = grid.getTile(shadowLayer.id, 0, 0, 0);
    expect(Array.from(shadowTile0!.data!.subarray(0, 4))).toEqual([90, 90, 90, 180]);

    // Paper: solid white across tiles
    expect(grid.hasLayerTiles(paperLayer.id)).toBe(true);
  });

  it('respects LayerOffsetX/Y, bitmap boundary clipping, 2-plane monochrome, and disabled masks', async () => {
    (globalThis as Record<string, unknown>).document = {
      createElement: () => createPixelCanvas(300, 300),
    };

    const SQL = await initSqlJs();
    const db = new SQL.Database();
    db.run(`
      CREATE TABLE Canvas (MainId INTEGER, CanvasWidth INTEGER, CanvasHeight INTEGER, CanvasRootFolder INTEGER);
      CREATE TABLE Layer (
        MainId INTEGER, LayerName TEXT, LayerType INTEGER, LayerFolder INTEGER,
        LayerComposite INTEGER, LayerOpacity INTEGER, LayerVisibility INTEGER,
        LayerLock INTEGER, LayerClip INTEGER, LayerSelect INTEGER,
        LayerOffsetX REAL, LayerOffsetY REAL,
        LayerNextIndex INTEGER, LayerFirstChildIndex INTEGER,
        LayerRenderMipmap INTEGER, LayerLayerMaskMipmap INTEGER
      );
      CREATE TABLE Mipmap (MainId INTEGER, BaseMipmapInfo INTEGER);
      CREATE TABLE MipmapInfo (MainId INTEGER, ThisScale REAL, Offscreen INTEGER, NextIndex INTEGER);
      CREATE TABLE Offscreen (MainId INTEGER, LayerId INTEGER, BlockData TEXT, Attribute BLOB);
    `);

    db.run('INSERT INTO Canvas VALUES (1, 300, 300, 1)');
    db.run('INSERT INTO Layer VALUES (1, "", 256, 1, 0, 256, 1, 0, 0, 0, 0, 0, 0, 2, 0, 0)');
    // Layer 2: shifted by (+10, +20), LayerVisibility=1 (visible, mask DISABLED), LayerSelect=0 (mask unlinked)
    db.run('INSERT INTO Layer VALUES (2, "Mono2Plane", 1, 0, 0, 256, 1, 1, 0, 0, 10, 20, 0, 0, 10, 11)');
    db.run('INSERT INTO Mipmap VALUES (10, 100), (11, 110)');
    db.run('INSERT INTO MipmapInfo VALUES (100, 1.0, 1000, 0), (110, 1.0, 1100, 0)');
    db.run('INSERT INTO Offscreen VALUES (1000, 2, "extrnlid_mono2", ?)', [buildOffscreenAttribute(100, 100, 0, 1, 1)]);
    db.run('INSERT INTO Offscreen VALUES (1100, 2, "extrnlid_mask2", ?)', [buildOffscreenAttribute(300, 300, 1, 0, 1)]);

    const sqliteBytes = db.export();
    db.close();

    // 2-plane 1-bit mono: pixel (0,0) = opaque white (alpha=1, color=1); pixel (1,0) = opaque black (alpha=1, color=0)
    const mono2 = new Uint8Array(16384);
    mono2[0] = 0xc0;        // alpha bits for x=0,1
    mono2[8192] = 0x80;     // white bit for x=0 only

    const clipBuf = buildClipFile([
      buildChunk('SQLi', sqliteBytes),
      buildExtaChunk('extrnlid_mono2', buildBlockData([mono2])),
      buildExtaChunk('extrnlid_mask2', buildBlockData([null, null, null, null])),
    ]);

    const doc = await parseCspFile(clipBuf, 'offset_mono.clip');
    expect(doc.layers.length).toBe(1);
    const layer = doc.layers[0];
    expect(layer.locked).toBe(true);
    expect(layer.maskEnabled).toBe(false);
    expect(layer.maskLinked).toBe(false);

    // Offset (+10, +20): (10,20) must be white (255,255,255,255) and (11,20) must be black (0,0,0,255)
    const tile = doc.tileGrid!.getTile(layer.id, 0, 0, 0)!;
    const idxWhite = (20 * TILE_SIZE + 10) * 4;
    const idxBlack = (20 * TILE_SIZE + 11) * 4;
    expect(Array.from(tile.data!.subarray(idxWhite, idxWhite + 4))).toEqual([255, 255, 255, 255]);
    expect(Array.from(tile.data!.subarray(idxBlack, idxBlack + 4))).toEqual([0, 0, 0, 255]);
  });

  it('accumulates parent folder LayerOffset, child LayerOffset, LayerRenderOffscrOffset, and LayerMaskOffscrOffset', async () => {
    (globalThis as Record<string, unknown>).document = {
      createElement: () => createPixelCanvas(512, 512),
    };

    const SQL = await initSqlJs();
    const db = new SQL.Database();
    db.run(`
      CREATE TABLE Canvas (MainId INTEGER, CanvasWidth INTEGER, CanvasHeight INTEGER, CanvasRootFolder INTEGER);
      CREATE TABLE Layer (
        MainId INTEGER, LayerName TEXT, LayerType INTEGER, LayerFolder INTEGER,
        LayerComposite INTEGER, LayerOpacity INTEGER, LayerVisibility INTEGER,
        LayerLock INTEGER, LayerClip INTEGER, LayerSelect INTEGER,
        LayerOffsetX REAL, LayerOffsetY REAL,
        LayerRenderOffscrOffsetX REAL, LayerRenderOffscrOffsetY REAL,
        LayerMaskOffsetX REAL, LayerMaskOffsetY REAL,
        LayerMaskOffscrOffsetX REAL, LayerMaskOffscrOffsetY REAL,
        LayerNextIndex INTEGER, LayerFirstChildIndex INTEGER,
        LayerRenderMipmap INTEGER, LayerLayerMaskMipmap INTEGER
      );
      CREATE TABLE Mipmap (MainId INTEGER, BaseMipmapInfo INTEGER);
      CREATE TABLE MipmapInfo (MainId INTEGER, ThisScale REAL, Offscreen INTEGER, NextIndex INTEGER);
      CREATE TABLE Offscreen (MainId INTEGER, LayerId INTEGER, BlockData TEXT, Attribute BLOB);
    `);

    db.run('INSERT INTO Canvas VALUES (1, 512, 512, 1)');
    db.run('INSERT INTO Layer VALUES (1, "", 256, 1, 0, 256, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 2, 0, 0)');
    // Folder moved by (+40, +50)
    db.run('INSERT INTO Layer VALUES (2, "MovedFolder", 256, 1, 30, 256, 1, 0, 0, 0, 40, 50, 0, 0, 0, 0, 0, 0, 0, 3, 0, 0)');
    // Child layer: LayerOffset(+10, +300), LayerRenderOffscrOffset(-30, -320) => effective render offset = (+20, +30)
    // Mask: LayerMaskOffset(+5, +10), LayerMaskOffscrOffset(-15, -300) => effective mask offset = (40+10+5-15, 50+300+10-300) = (+40, +60)
    db.run('INSERT INTO Layer VALUES (3, "Painted", 1, 0, 0, 256, 3, 0, 0, 256, 10, 300, -30, -320, 5, 10, -15, -300, 0, 0, 10, 11)');

    db.run('INSERT INTO Mipmap VALUES (10, 100), (11, 110)');
    db.run('INSERT INTO MipmapInfo VALUES (100, 1.0, 1000, 0), (110, 1.0, 1100, 0)');
    db.run('INSERT INTO Offscreen VALUES (1000, 3, "extrnlid_off_paint", ?)', [buildOffscreenAttribute(256, 256, 0, 1, 4)]);
    db.run('INSERT INTO Offscreen VALUES (1100, 3, "extrnlid_off_mask", ?)', [buildOffscreenAttribute(256, 256, 0, 0, 1)]);

    const sqliteBytes = db.export();
    db.close();

    const paintTile = makeColorTile(10, 200, 30, 255);
    const maskTile = new Uint8Array(TILE_PIXELS).fill(180);

    const clipBuf = buildClipFile([
      buildChunk('SQLi', sqliteBytes),
      buildExtaChunk('extrnlid_off_paint', buildBlockData([paintTile])),
      buildExtaChunk('extrnlid_off_mask', buildBlockData([maskTile])),
    ]);

    const doc = await parseCspFile(clipBuf, 'offsets.clip');
    const painted = doc.layers.find((l) => l.name === 'Painted')!;

    // Tile starts at (+20, +30): pixel (19, 30) must be transparent, pixel (20, 30) must be RGBA(10, 200, 30, 255)
    const tile = doc.tileGrid!.getTile(painted.id, 0, 0, 0)!;
    const beforeIdx = (30 * TILE_SIZE + 19) * 4;
    const startIdx = (30 * TILE_SIZE + 20) * 4;
    expect(Array.from(tile.data!.subarray(beforeIdx, beforeIdx + 4))).toEqual([0, 0, 0, 0]);
    expect(Array.from(tile.data!.subarray(startIdx, startIdx + 4))).toEqual([10, 200, 30, 255]);

    // Mask starts at (+40, +60): pixel (39, 60) = 0, pixel (40, 60) = 180
    const mCtx = painted.maskCanvas!.getContext('2d')!;
    expect(mCtx.getImageData(39, 60, 1, 1).data[0]).toBe(0);
    expect(mCtx.getImageData(40, 60, 1, 1).data[0]).toBe(180);
  });

  it('guards against cyclic LayerNextIndex pointers and minimal/missing columns without hanging', async () => {
    const SQL = await initSqlJs();
    const db = new SQL.Database();
    db.run(`
      CREATE TABLE Canvas (CanvasWidth INTEGER, CanvasHeight INTEGER, CanvasRootFolder INTEGER);
      CREATE TABLE Layer (MainId INTEGER, LayerName TEXT, LayerNextIndex INTEGER, LayerFirstChildIndex INTEGER);
    `);
    db.run('INSERT INTO Canvas VALUES (256, 256, 1)');
    db.run('INSERT INTO Layer VALUES (1, "", 0, 2)');
    db.run('INSERT INTO Layer VALUES (2, "CycleA", 3, 0)');
    db.run('INSERT INTO Layer VALUES (3, "CycleB", 2, 0)'); // cycle back to 2!
    const sqliteBytes = db.export();
    db.close();

    const clipBuf = buildClipFile([buildChunk('SQLi', sqliteBytes)]);
    const doc = await parseCspFile(clipBuf, 'cyclic.clip');

    expect(doc.layers.map((l) => l.name)).toEqual(['CycleB', 'CycleA']);
    expect(doc.layers.every((l) => l.type === 'raster')).toBe(true);
  });
});
