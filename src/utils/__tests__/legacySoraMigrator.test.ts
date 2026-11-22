import { describe, it, expect } from 'vitest';
import { zipSync } from 'fflate';
import {
  extractLegacySoraPreview,
  hasLegacySoraHeader,
  isLegacySoraExtension,
  isLegacySoraV2Bytes,
  migrateLegacySoraBytes,
  parseLegacySoraV1Json,
} from '../legacySoraMigrator';
import { openFile } from '../imageLoader';

describe('Read-Only Legacy .sora Migrator', () => {
  it('migrates legacy .sora v1.2 JSON (string & UTF-8 bytes with BOM) and strips prototype keys', async () => {
    const v1Json = JSON.stringify({
      app: 'Sora Paint',
      version: '1.2',
      name: 'Legacy Project',
      dimensions: { width: 1440, height: 900, dpi: 300 },
      colorMode: 'color',
      layers: [
        {
          id: 'layer-bg',
          name: 'Background',
          type: 'raster',
          visible: true,
          opacity: 1,
          blendMode: 'normal',
          locked: false,
          parentId: null,
        },
      ],
      canvases: {},
      masks: {},
    });

    const parsedStr = await migrateLegacySoraBytes(v1Json);
    expect(parsedStr.migratedFrom).toBe('sora-v1');
    expect(parsedStr.format).toBe('sora-v1');
    expect(parsedStr.version).toBe('1.2');
    expect(parsedStr.name).toBe('Legacy Project');
    expect(parsedStr.layers).toHaveLength(1);

    const utf8WithBom = new Uint8Array([0xef, 0xbb, 0xbf, ...new TextEncoder().encode(v1Json)]);
    expect(isLegacySoraV2Bytes(utf8WithBom)).toBe(false);
    const parsedBytes = await migrateLegacySoraBytes(utf8WithBom.buffer);
    expect(parsedBytes.migratedFrom).toBe('sora-v1');
    expect(parsedBytes.name).toBe('Legacy Project');

    const polluted = parseLegacySoraV1Json(
      '{"layers":[{"id":"l1","name":"L1","type":"raster","visible":true,"opacity":1,"blendMode":"normal","locked":false,"parentId":null,"__proto__":{"polluted":true}}]}'
    );
    expect((polluted.layers[0] as unknown as Record<string, unknown>).polluted).toBeUndefined();
  });

  it('migrates legacy .sora v2 ZIP archives with or without 8-byte SORA\\x00\\x02 wrapper prefix and extracts preview.png', async () => {
    const fakePng = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
    const manifest = {
      format: 'sora-v2',
      app: 'Ink Studio',
      version: '2.0',
      tileSize: 256,
      name: 'Legacy V2 Doc',
      dimensions: { width: 512, height: 512, dpi: 300 },
      colorMode: 'color',
      layers: [],
      layerFormats: {},
      layerTileKeys: {},
      masksMeta: {},
      preview: { path: 'preview.png', width: 256, height: 256 },
      savedAt: Date.now(),
    };

    const zipBytes = zipSync({
      'manifest.json': new TextEncoder().encode(JSON.stringify(manifest)),
      'preview.png': fakePng,
    });

    expect(Array.from(extractLegacySoraPreview(zipBytes)!)).toEqual(Array.from(fakePng));

    const wrapped = new Uint8Array(8 + zipBytes.byteLength);
    wrapped.set([0x53, 0x4f, 0x52, 0x41, 0x00, 0x02, 0x00, 0x00], 0);
    wrapped.set(zipBytes, 8);
    expect(hasLegacySoraHeader(wrapped)).toBe(true);
    expect(isLegacySoraV2Bytes(wrapped)).toBe(true);
    expect(Array.from(extractLegacySoraPreview(wrapped)!)).toEqual(Array.from(fakePng));

    const migrated = await migrateLegacySoraBytes(wrapped);
    expect(migrated.migratedFrom).toBe('sora-v2');
    if (migrated.migratedFrom !== 'sora-v2') throw new Error('Expected sora-v2');
    expect(migrated.format).toBe('ink-v2');
    expect(migrated.name).toBe('Legacy V2 Doc');
    expect(migrated.previewDataUrl).toMatch(/^data:image\/png;base64,/);
  });

  it('routes .sora files in openFile through the read-only migrator', async () => {
    const manifest = {
      format: 'sora-v2',
      app: 'Ink Studio',
      version: '2.0',
      tileSize: 256,
      name: 'Old Chapter',
      dimensions: { width: 640, height: 480, dpi: 300 },
      colorMode: 'color',
      layers: [],
      layerFormats: {},
      layerTileKeys: {},
      masksMeta: {},
      preview: null,
      savedAt: Date.now(),
    };
    const zipBytes = zipSync({
      'manifest.json': new TextEncoder().encode(JSON.stringify(manifest)),
    });
    const file = new File([zipBytes as BlobPart], 'old-chapter.sora', {
      type: 'application/octet-stream',
    });

    const loaded = await openFile(file);
    expect(loaded.name).toBe('Old Chapter');
    expect(loaded.dimensions).toEqual({ width: 640, height: 480, dpi: 300 });
    expect(isLegacySoraExtension(file.name)).toBe(true);
    expect(isLegacySoraExtension('new-chapter.ink')).toBe(false);
  });

  it('rejects path traversal and corrupted payloads inside legacy .sora archives', async () => {
    const evilZip = zipSync({
      'manifest.json': new TextEncoder().encode(
        JSON.stringify({ dimensions: { width: 256, height: 256 }, layers: [] })
      ),
      '../escape.bin': new Uint8Array([1, 2, 3]),
    });
    await expect(migrateLegacySoraBytes(evilZip)).rejects.toThrow(/Unsafe archive path/);
  });
});
