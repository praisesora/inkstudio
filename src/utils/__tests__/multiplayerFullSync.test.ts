import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  multiplayerService,
  sanitizeIncomingJsonMessage,
  BINARY_MAGIC_0,
  BINARY_MAGIC_1,
  CODE_LAYER_MASK_DATA,
  CODE_TILE_DELTA,
} from '../../services/multiplayerService';
import {
  applyRemoteLayerPatch,
  diffWireLayerTrees,
  mergeRemoteWireLayerIntoLocal,
  sanitizeAnimationTimeline,
  sanitizeCanvasResize,
  sanitizePerspectiveRuler,
  sanitizeStraightRuler,
  sanitizeWireLayerTree,
  serializeLayerForWire,
} from '../collabSyncUtils';
import { SparseTileGrid } from '../tileEngine';
import type { LayerItem } from '../../types/editor';
import type { WireLayerItem } from '../../types/multiplayer';

function makeLayer(overrides: Partial<LayerItem> = {}): LayerItem {
  return {
    id: overrides.id ?? 'layer-1',
    name: overrides.name ?? 'Layer 1',
    type: overrides.type ?? 'raster',
    visible: overrides.visible ?? true,
    opacity: overrides.opacity ?? 1,
    blendMode: overrides.blendMode ?? 'normal',
    locked: overrides.locked ?? false,
    parentId: overrides.parentId ?? null,
    ...overrides,
  };
}

describe('Full Layer Tree Diff & Patch Engine', () => {
  it('ignores transient UI fields (thumbnailUrl, maskThumbnailUrl, collapsed, maskVersion)', () => {
    const a = makeLayer({ id: 'l1', thumbnailUrl: 'data:a', collapsed: false });
    const b = makeLayer({ id: 'l1', thumbnailUrl: 'data:b', collapsed: true, maskVersion: 9 });
    const diff = diffWireLayerTrees([serializeLayerForWire(a)], [serializeLayerForWire(b)]);
    expect(diff.kind).toBe('none');
  });

  it('emits minimal single-update patches for blendMode, clipping, alphaLock, styles, adjustment, text, balloon, frames', () => {
    const base = serializeLayerForWire(makeLayer({ id: 'l1' }));
    const modified = serializeLayerForWire(
      makeLayer({
        id: 'l1',
        blendMode: 'multiply',
        clipped: true,
        alphaLocked: true,
        styles: {
          stroke: { enabled: true, size: 4, color: '#000000', position: 'outside', opacity: 1 },
        },
        toneEnabled: true,
        toneFrequency: 65,
      })
    );

    const diff = diffWireLayerTrees([base], [modified]);
    expect(diff.kind).toBe('single-update');
    if (diff.kind === 'single-update') {
      expect(diff.layerId).toBe('l1');
      expect(diff.patch).toMatchObject({
        blendMode: 'multiply',
        clipped: true,
        alphaLocked: true,
        toneEnabled: true,
        toneFrequency: 65,
      });
      expect(diff.patch.styles?.stroke?.size).toBe(4);
      expect(diff.clearedFields).toEqual([]);
    }
  });

  it('tracks clearedFields explicitly when optional properties or masks are removed', () => {
    const withMaskAndStyles: WireLayerItem = {
      ...serializeLayerForWire(
        makeLayer({
          id: 'l1',
          styles: { outerGlow: { enabled: true, color: '#fff', opacity: 0.8, blur: 10, spread: 0 } },
          maskEnabled: true,
          maskLinked: true,
        })
      ),
      hasMask: true,
    };
    const cleared = serializeLayerForWire(makeLayer({ id: 'l1' }));

    const diff = diffWireLayerTrees([withMaskAndStyles], [cleared]);
    expect(diff.kind).toBe('single-update');
    if (diff.kind === 'single-update') {
      expect(diff.maskRemoved).toBe(true);
      expect(diff.clearedFields).toContain('styles');
      expect(diff.clearedFields).toContain('hasMask');
      expect(diff.clearedFields).toContain('maskEnabled');
      expect(diff.clearedFields).toContain('maskLinked');

      const applied = applyRemoteLayerPatch(
        makeLayer({
          id: 'l1',
          styles: withMaskAndStyles.styles,
          maskEnabled: true,
          maskLinked: true,
        }),
        diff.patch,
        diff.clearedFields
      );
      expect(applied.styles).toBeUndefined();
      expect(applied.maskEnabled).toBeUndefined();
      expect(applied.maskLinked).toBeUndefined();
      expect(applied.maskCanvas).toBeUndefined();
    }
  });

  it('emits tree-sync for layer reorder, grouping, and multi-delete', () => {
    const l1 = serializeLayerForWire(makeLayer({ id: 'l1' }));
    const l2 = serializeLayerForWire(makeLayer({ id: 'l2' }));
    const bg = serializeLayerForWire(makeLayer({ id: 'layer-bg' }));

    // Reorder
    const reorderDiff = diffWireLayerTrees([l1, l2, bg], [l2, l1, bg]);
    expect(reorderDiff.kind).toBe('tree-sync');

    // Grouping into folder
    const folder = serializeLayerForWire(makeLayer({ id: 'folder-1', type: 'folder', blendMode: 'pass-through' }));
    const groupDiff = diffWireLayerTrees(
      [l1, l2, bg],
      [folder, { ...l1, parentId: 'folder-1' }, { ...l2, parentId: 'folder-1' }, bg]
    );
    expect(groupDiff.kind).toBe('tree-sync');
    if (groupDiff.kind === 'tree-sync') {
      expect(groupDiff.addedLayerIds).toEqual(['folder-1']);
      expect(groupDiff.removedLayerIds).toEqual([]);
    }

    // Multi-delete
    const delDiff = diffWireLayerTrees([l1, l2, bg], [bg]);
    expect(delDiff.kind).toBe('tree-sync');
    if (delDiff.kind === 'tree-sync') {
      expect(delDiff.removedLayerIds).toEqual(['l1', 'l2']);
    }
  });

  it('preserves local collapsed UI state when merging remote wire layers', () => {
    const localFolder = makeLayer({ id: 'f1', type: 'folder', collapsed: true, name: 'Old' });
    const remoteWire: WireLayerItem = {
      id: 'f1',
      name: 'Renamed Folder',
      type: 'folder',
      visible: true,
      opacity: 0.7,
      blendMode: 'pass-through',
      locked: false,
      parentId: null,
    };
    const merged = mergeRemoteWireLayerIntoLocal(localFolder, remoteWire, { width: 512, height: 512 });
    expect(merged.name).toBe('Renamed Folder');
    expect(merged.opacity).toBe(0.7);
    expect(merged.collapsed).toBe(true);
  });
});

describe('Security Sanitization & Protocol Validation', () => {
  it('breaks parentId cycles, rejects prototype pollution keys, and clamps numeric ranges', () => {
    const raw = [
      {
        id: 'f1',
        name: 'F1',
        type: 'folder',
        visible: true,
        opacity: 99,
        blendMode: 'invalid-mode',
        locked: false,
        parentId: 'f2',
        toneFrequency: 999,
        styles: JSON.parse('{"__proto__":{"polluted":true},"stroke":{"enabled":true,"size":3,"color":"#000","position":"outside","opacity":1}}'),
      },
      {
        id: 'f2',
        name: 'F2',
        type: 'folder',
        visible: true,
        opacity: -5,
        blendMode: 'multiply',
        locked: false,
        parentId: 'f1',
      },
    ];

    const sanitized = sanitizeWireLayerTree(raw);
    expect(sanitized).not.toBeNull();
    expect(sanitized!.length).toBe(2);
    expect(sanitized![0].opacity).toBe(1);
    expect(sanitized![1].opacity).toBe(0);
    expect(sanitized![0].blendMode).toBe('pass-through');
    expect(sanitized![0].toneFrequency).toBe(85);
    expect(sanitized![0].parentId === null || sanitized![1].parentId === null).toBe(true);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it('sanitizes perspective ruler, straight ruler, animation timeline, and canvas resize messages', () => {
    expect(sanitizePerspectiveRuler(null)).toBeNull();
    expect(sanitizePerspectiveRuler({ type: '99-point', vps: [] })).toBeUndefined();
    const validPersp = sanitizePerspectiveRuler({
      id: 'p1',
      type: '2-point',
      enabled: true,
      locked: false,
      snapEnabled: true,
      vps: [
        { id: 'vp1', x: 100, y: 200, label: 'VP1', color: '#f00' },
        { id: 'vp2', x: 900, y: 200, label: 'VP2', color: '#00f' },
      ],
      horizonAngle: 0,
      guideRayCount: 12,
      grid: { enabled: true, density: 16, plane: 'ground', opacity: 0.4 },
    });
    expect(validPersp?.vps.length).toBe(2);

    expect(sanitizeStraightRuler({ x: NaN, y: 0 })).toBeUndefined();
    expect(sanitizeStraightRuler({ enabled: true, x: 50, y: 60, angle: 45, locked: false, snapEnabled: true })).toMatchObject({
      x: 50,
      y: 60,
      angle: 45,
    });

    const anim = sanitizeAnimationTimeline({
      fps: 24,
      totalFrames: 48,
      currentFrame: 999,
      cels: { 0: 'layer-1', 12: 'layer-cel-2', bad: 'x' },
      onionSkin: { enabled: true, prevFrames: 2, nextFrames: 1, prevTint: '#f00', nextTint: '#00f', opacity: 0.5 },
      isPlaying: true,
      loop: true,
    });
    expect(anim).not.toBeNull();
    expect(anim!.currentFrame).toBe(47);
    expect(anim!.isPlaying).toBe(false);
    expect(anim!.cels).toEqual({ 0: 'layer-1', 12: 'layer-cel-2' });

    const resize = sanitizeCanvasResize({
      dimensions: { width: 2000, height: 3000, dpi: 600 },
      options: { width: 2000, height: 3000, scaleContent: true, anchor: 'top-left', backgroundColor: '#fff' },
    });
    expect(resize?.dimensions).toEqual({ width: 2000, height: 3000, dpi: 600 });
    expect(sanitizeCanvasResize({ dimensions: { width: -10, height: 100 } })).toBeNull();
  });

  it('sanitizes incoming JSON protocol messages and drops malformed payloads', () => {
    const validUpdate = sanitizeIncomingJsonMessage({
      type: 'LAYER_UPDATE',
      layerId: 'l1',
      patch: { blendMode: 'overlay', clipped: true, thumbnailUrl: 'javascript:alert(1)' },
      clearedFields: ['styles', '__proto__'],
      lamport: 7,
    });
    expect(validUpdate?.type).toBe('LAYER_UPDATE');
    if (validUpdate?.type === 'LAYER_UPDATE') {
      expect(validUpdate.patch).toEqual({ blendMode: 'overlay', clipped: true });
      expect(validUpdate.clearedFields).toEqual(['styles']);
    }

    // Empty / invalid patch is dropped
    expect(
      sanitizeIncomingJsonMessage({ type: 'LAYER_UPDATE', layerId: 'l1', patch: {} })
    ).toBeNull();

    // DOC_SYNC_RESPONSE preserves rulers & animation timeline
    const docSync = sanitizeIncomingJsonMessage({
      type: 'DOC_SYNC_RESPONSE',
      targetPeerId: 'peer-2',
      dimensions: { width: 1440, height: 900, dpi: 300 },
      colorMode: 'color',
      layers: [makeLayer({ id: 'l1', blendMode: 'multiply', alphaLocked: true })],
      straightRuler: { enabled: true, x: 720, y: 450, angle: 30, locked: false, snapEnabled: true },
      animationTimeline: {
        fps: 12,
        totalFrames: 24,
        currentFrame: 3,
        cels: { 0: 'l1' },
        onionSkin: { enabled: false, prevFrames: 1, nextFrames: 1, prevTint: '#f00', nextTint: '#00f', opacity: 0.3 },
      },
    });
    expect(docSync?.type).toBe('DOC_SYNC_RESPONSE');
    if (docSync?.type === 'DOC_SYNC_RESPONSE') {
      expect(docSync.straightRuler?.angle).toBe(30);
      expect(docSync.animationTimeline?.currentFrame).toBe(3);
      expect(docSync.layers[0].blendMode).toBe('multiply');
      expect(docSync.layers[0].alphaLocked).toBe(true);
    }
  });
});

describe('Binary Mask Packet Codec & Tile Version Deduplication', () => {
  const toArrayBuffer = (u8: Uint8Array): ArrayBuffer =>
    u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength) as ArrayBuffer;

  beforeEach(() => {
    multiplayerService.clearSyncDedupeCaches();
  });

  it('encodes and decodes 1-byte solid-fill BINARY_MASK packets losslessly', () => {
    const sent: Uint8Array[] = [];
    const sendSpy = vi.spyOn(multiplayerService, 'sendBinary').mockImplementation((buf) => {
      sent.push(buf instanceof Uint8Array ? buf : new Uint8Array(buf));
    });
    const connSpy = vi.spyOn(multiplayerService, 'isConnected').mockReturnValue(true);

    multiplayerService.sendLayerMaskSolid('layer-mask-1', 4096, 4096, 255, true);
    expect(sent.length).toBe(1);
    expect(sent[0][0]).toBe(BINARY_MAGIC_0);
    expect(sent[0][1]).toBe(BINARY_MAGIC_1);
    expect(sent[0][2]).toBe(CODE_LAYER_MASK_DATA);
    // Whole 4096x4096 solid white mask fits in < 64 bytes
    expect(sent[0].byteLength).toBeLessThan(64);

    const decoded = multiplayerService.decodeBinaryPacket(toArrayBuffer(sent[0]));
    expect(decoded).toEqual({
      type: 'BINARY_MASK',
      layerId: 'layer-mask-1',
      x: 0,
      y: 0,
      width: 4096,
      height: 4096,
      isFullReplace: true,
      solidFill: 255,
      data: null,
    });

    // Reject oversized / malformed binary mask dimensions
    const badPacket = sent[0].slice();
    const badView = new DataView(badPacket.buffer);
    const layerIdLen = badView.getUint16(11, true);
    // Overwrite width with 99999 (> MAX_SYNC_CANVAS_DIM)
    badView.setUint32(11 + 2 + layerIdLen + 1 + 8, 99999, true);
    expect(multiplayerService.decodeBinaryPacket(toArrayBuffer(badPacket))).toBeNull();

    // Non-solid grayscale mask dirty rect LZ4 round-trip
    sent.length = 0;
    const width = 32;
    const height = 16;
    const rgba = new Uint8ClampedArray(width * height * 4);
    for (let i = 0; i < width * height; i++) {
      const v = i % 256;
      rgba[i * 4] = v;
      rgba[i * 4 + 1] = v;
      rgba[i * 4 + 2] = v;
      rgba[i * 4 + 3] = 255;
    }
    const fakeMaskCanvas = {
      width,
      height,
      getContext: () => ({
        getImageData: () => ({ data: rgba, width, height }),
      }),
    } as unknown as HTMLCanvasElement;

    multiplayerService.sendLayerMaskData('layer-mask-2', fakeMaskCanvas, {
      x: 0,
      y: 0,
      width,
      height,
    });
    expect(sent.length).toBe(1);
    expect(sent[0][2]).toBe(CODE_LAYER_MASK_DATA);
    const decodedPatch = multiplayerService.decodeBinaryPacket(toArrayBuffer(sent[0]));
    expect(decodedPatch?.type).toBe('BINARY_MASK');
    if (decodedPatch?.type === 'BINARY_MASK') {
      expect(decodedPatch.layerId).toBe('layer-mask-2');
      expect(decodedPatch.width).toBe(width);
      expect(decodedPatch.height).toBe(height);
      expect(decodedPatch.solidFill).toBeUndefined();
      expect(decodedPatch.data?.byteLength).toBe(width * height);
      expect(decodedPatch.data?.[0]).toBe(0);
      expect(decodedPatch.data?.[127]).toBe(127);
      expect(decodedPatch.data?.[255]).toBe(255);
    }

    sendSpy.mockRestore();
    connSpy.mockRestore();
  });

  it('deduplicates unchanged tile versions in streamLayerTiles unless force=true', () => {
    const sent: Uint8Array[] = [];
    const sendSpy = vi.spyOn(multiplayerService, 'sendBinary').mockImplementation((buf) => {
      sent.push(buf instanceof Uint8Array ? buf : new Uint8Array(buf));
    });
    const connSpy = vi.spyOn(multiplayerService, 'isConnected').mockReturnValue(true);

    const grid = new SparseTileGrid();
    const img = { data: new Uint8ClampedArray(16 * 16 * 4).fill(180), width: 16, height: 16 };
    grid.writeImageData('layer-1', img, 0, 0, 'color-32bit');

    multiplayerService.streamLayerTiles('layer-1', grid);
    expect(sent.length).toBe(1);
    expect(sent[0][2]).toBe(CODE_TILE_DELTA);

    // Second call with unchanged version is skipped
    multiplayerService.streamLayerTiles('layer-1', grid);
    expect(sent.length).toBe(1);

    // Force bypasses dedupe
    multiplayerService.streamLayerTiles('layer-1', grid, { force: true });
    expect(sent.length).toBe(2);

    sendSpy.mockRestore();
    connSpy.mockRestore();
  });
});
