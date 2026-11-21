import { describe, it, expect } from 'vitest';
import { LayerItem } from '../../types/editor';
import { resolveLiquifyTargetLayers } from '../liquifyEngine';

function makeLayer(overrides: Partial<LayerItem> & { id: string }): LayerItem {
  return {
    name: overrides.id,
    type: 'raster',
    visible: true,
    opacity: 1,
    blendMode: 'normal',
    locked: false,
    parentId: null,
    ...overrides,
  };
}

describe('Multi-layer Liquify target resolution', () => {
  const folder = makeLayer({ id: 'folder-1', type: 'folder' });
  const lockedFolder = makeLayer({ id: 'folder-locked', type: 'folder', locked: true });
  const l1 = makeLayer({ id: 'layer-1', parentId: 'folder-1' });
  const l2 = makeLayer({ id: 'layer-2', parentId: 'folder-1' });
  const l3 = makeLayer({ id: 'layer-3' });
  const lHidden = makeLayer({ id: 'layer-hidden', visible: false });
  const lLocked = makeLayer({ id: 'layer-locked', locked: true });
  const lInLockedFolder = makeLayer({ id: 'layer-in-locked', parentId: 'folder-locked' });
  const lBg = makeLayer({ id: 'layer-bg', locked: true });
  const lText = makeLayer({ id: 'layer-text', type: 'text' });

  const allLayers = [
    folder,
    l1,
    l2,
    lockedFolder,
    lInLockedFolder,
    l3,
    lHidden,
    lLocked,
    lText,
    lBg,
  ];
  const isVisible = (l: LayerItem) => l.visible;

  it('targets only the active layer when multiLayer is false', () => {
    const res = resolveLiquifyTargetLayers(allLayers, l1, ['layer-1', 'layer-2'], isVisible, false);
    expect(res.map((l) => l.id)).toEqual(['layer-1']);

    const lockedRes = resolveLiquifyTargetLayers(allLayers, lLocked, [], isVisible, false);
    expect(lockedRes).toEqual([]);
  });

  it('targets all visible unlocked raster layers when multiLayer is true and single layer is active', () => {
    const res = resolveLiquifyTargetLayers(allLayers, l1, ['layer-1'], isVisible, true);
    expect(res.map((l) => l.id)).toEqual(['layer-1', 'layer-2', 'layer-3']);
  });

  it('targets only visible unlocked descendants when active layer is a folder in multi-layer mode', () => {
    const res = resolveLiquifyTargetLayers(allLayers, folder, ['folder-1'], isVisible, true);
    expect(res.map((l) => l.id)).toEqual(['layer-1', 'layer-2']);
  });

  it('targets explicitly multi-selected layers (expanding selected folders) in multi-layer mode', () => {
    const res = resolveLiquifyTargetLayers(
      allLayers,
      l1,
      ['layer-1', 'layer-3', 'layer-locked'],
      isVisible,
      true
    );
    expect(res.map((l) => l.id)).toEqual(['layer-1', 'layer-3']);

    const folderMulti = resolveLiquifyTargetLayers(
      allLayers,
      folder,
      ['folder-1', 'layer-3'],
      isVisible,
      true
    );
    expect(folderMulti.map((l) => l.id)).toEqual(['layer-1', 'layer-2', 'layer-3']);
  });
});
