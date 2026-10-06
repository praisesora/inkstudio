import { describe, it, expect } from 'vitest';
import { LayerItem } from '../../types/editor';
import {
  computeLayerSelection,
  computeBatchDeleteLayers,
  computeGroupLayers,
  computeBatchReorderLayers,
  computeBatchVisibility,
  computeBatchLock,
} from '../../hooks/useLayerManager';

function makeLayer(id: string, name: string, type: 'raster' | 'folder' = 'raster', parentId: string | null = null): LayerItem {
  return {
    id,
    name,
    type,
    visible: true,
    opacity: 1,
    blendMode: type === 'folder' ? 'pass-through' : 'normal',
    locked: false,
    collapsed: false,
    parentId,
    thumbnailUrl: '',
  };
}

describe('Multi-Layer Tree Selection and Batch Operations', () => {
  const baseLayers: LayerItem[] = [
    makeLayer('l1', 'Layer 1'),
    makeLayer('l2', 'Layer 2'),
    makeLayer('l3', 'Layer 3'),
    makeLayer('l4', 'Layer 4'),
    makeLayer('l5', 'Layer 5'),
  ];

  describe('computeLayerSelection', () => {
    it('sets single selection and pivot on normal click', () => {
      const res = computeLayerSelection(baseLayers, ['l1'], 'l1', 'l1', 'l3', false, false);
      expect(res.nextSelectedIds).toEqual(['l3']);
      expect(res.nextActiveId).toBe('l3');
      expect(res.nextPivotId).toBe('l3');
    });

    it('supports additive and toggle selection with Ctrl+Click', () => {
      // Add l2 to l1
      const res1 = computeLayerSelection(baseLayers, ['l1'], 'l1', 'l1', 'l2', false, true);
      expect(res1.nextSelectedIds).toEqual(['l1', 'l2']);
      expect(res1.nextActiveId).toBe('l2');

      // Add l3
      const res2 = computeLayerSelection(baseLayers, res1.nextSelectedIds, 'l2', 'l2', 'l3', false, true);
      expect(res2.nextSelectedIds).toEqual(['l1', 'l2', 'l3']);
      expect(res2.nextActiveId).toBe('l3');

      // Toggle off l2
      const res3 = computeLayerSelection(baseLayers, res2.nextSelectedIds, 'l3', 'l3', 'l2', false, true);
      expect(res3.nextSelectedIds).toEqual(['l1', 'l3']);
      expect(res3.nextActiveId).toBe('l3');

      // Toggle off l3 (active layer), falls back to remaining selection
      const res4 = computeLayerSelection(baseLayers, res3.nextSelectedIds, 'l3', 'l3', 'l3', false, true);
      expect(res4.nextSelectedIds).toEqual(['l1']);
      expect(res4.nextActiveId).toBe('l1');
    });

    it('supports contiguous range selection with Shift+Click', () => {
      // Pivot is l1, click l4
      const res = computeLayerSelection(baseLayers, ['l1'], 'l1', 'l1', 'l4', true, false);
      expect(res.nextSelectedIds).toEqual(['l1', 'l2', 'l3', 'l4']);
      expect(res.nextActiveId).toBe('l4');
      expect(res.nextPivotId).toBe('l1');
    });

    it('supports additive range selection with Ctrl+Shift+Click', () => {
      // Initially l1 selected, Ctrl+Shift range l3 to l5
      const res = computeLayerSelection(baseLayers, ['l1'], 'l1', 'l3', 'l5', true, true);
      expect(res.nextSelectedIds).toEqual(['l1', 'l3', 'l4', 'l5']);
      expect(res.nextActiveId).toBe('l5');
    });
  });

  describe('computeGroupLayers', () => {
    it('groups multiple selected layers into a new folder with pass-through blend mode', () => {
      const selected = ['l2', 'l3', 'l4'];
      const res = computeGroupLayers(baseLayers, selected, 'l4', 'folder-test');
      expect(res).not.toBeNull();
      if (!res) return;

      const { nextLayers, newFolder } = res;
      expect(newFolder.id).toBe('folder-test');
      expect(newFolder.type).toBe('folder');
      expect(newFolder.blendMode).toBe('pass-through');

      // Folder inserted at index of l2
      expect(nextLayers[1].id).toBe('folder-test');
      expect(nextLayers[2].id).toBe('l2');
      expect(nextLayers[3].id).toBe('l3');
      expect(nextLayers[4].id).toBe('l4');

      // Grouped items have parentId set to folder
      expect(nextLayers.find((l) => l.id === 'l2')?.parentId).toBe('folder-test');
      expect(nextLayers.find((l) => l.id === 'l3')?.parentId).toBe('folder-test');
      expect(nextLayers.find((l) => l.id === 'l4')?.parentId).toBe('folder-test');
      // Ungrouped items remain parentless
      expect(nextLayers.find((l) => l.id === 'l1')?.parentId).toBeNull();
      expect(nextLayers.find((l) => l.id === 'l5')?.parentId).toBeNull();
    });

    it('preserves existing child hierarchy when grouping a folder and its children', () => {
      const nestedLayers: LayerItem[] = [
        makeLayer('f1', 'Folder 1', 'folder', null),
        makeLayer('c1', 'Child 1', 'raster', 'f1'),
        makeLayer('c2', 'Child 2', 'raster', 'f1'),
        makeLayer('l1', 'Layer 1', 'raster', null),
      ];

      const res = computeGroupLayers(nestedLayers, ['f1', 'l1'], 'f1', 'parent-folder');
      expect(res).not.toBeNull();
      if (!res) return;

      const { nextLayers, newFolder } = res;
      expect(newFolder.id).toBe('parent-folder');

      // f1 and l1 reparent to parent-folder
      expect(nextLayers.find((l) => l.id === 'f1')?.parentId).toBe('parent-folder');
      expect(nextLayers.find((l) => l.id === 'l1')?.parentId).toBe('parent-folder');
      // c1 and c2 remain inside f1
      expect(nextLayers.find((l) => l.id === 'c1')?.parentId).toBe('f1');
      expect(nextLayers.find((l) => l.id === 'c2')?.parentId).toBe('f1');
    });
  });

  describe('computeBatchDeleteLayers', () => {
    it('deletes all selected layers and recursively deletes child layers of folders', () => {
      const treeLayers: LayerItem[] = [
        makeLayer('f1', 'Folder 1', 'folder', null),
        makeLayer('c1', 'Child 1', 'raster', 'f1'),
        makeLayer('c2', 'Child 2', 'raster', 'f1'),
        makeLayer('l3', 'Layer 3', 'raster', null),
        makeLayer('l4', 'Layer 4', 'raster', null),
      ];

      // Delete folder f1 and l3
      const res = computeBatchDeleteLayers(treeLayers, ['f1', 'l3'], 'l3');
      expect(res.deletedIds).toContain('f1');
      expect(res.deletedIds).toContain('c1');
      expect(res.deletedIds).toContain('c2');
      expect(res.deletedIds).toContain('l3');
      expect(res.nextLayers.map((l) => l.id)).toEqual(['l4']);
      expect(res.nextActiveId).toBe('l4');
    });

    it('prevents deleting the last raster layer', () => {
      const singleRaster: LayerItem[] = [
        makeLayer('bg', 'Background', 'raster', null),
      ];
      const res = computeBatchDeleteLayers(singleRaster, ['bg'], 'bg');
      expect(res.nextLayers.length).toBe(1);
      expect(res.nextLayers[0].id).toBe('bg');
    });
  });

  describe('computeBatchVisibility and computeBatchLock', () => {
    it('toggles visibility for all selected layers simultaneously', () => {
      const selected = ['l1', 'l2'];
      // l1 and l2 start visible: true
      const res1 = computeBatchVisibility(baseLayers, selected, 'l1');
      expect(res1.find((l) => l.id === 'l1')?.visible).toBe(false);
      expect(res1.find((l) => l.id === 'l2')?.visible).toBe(false);
      expect(res1.find((l) => l.id === 'l3')?.visible).toBe(true);

      // Toggle back
      const res2 = computeBatchVisibility(res1, selected, 'l1');
      expect(res2.find((l) => l.id === 'l1')?.visible).toBe(true);
      expect(res2.find((l) => l.id === 'l2')?.visible).toBe(true);
    });

    it('toggles lock state for all selected layers simultaneously', () => {
      const selected = ['l2', 'l3'];
      const res1 = computeBatchLock(baseLayers, selected, 'l2');
      expect(res1.find((l) => l.id === 'l2')?.locked).toBe(true);
      expect(res1.find((l) => l.id === 'l3')?.locked).toBe(true);
      expect(res1.find((l) => l.id === 'l1')?.locked).toBe(false);
    });
  });

  describe('computeBatchReorderLayers', () => {
    it('moves multi-layer selection together below target', () => {
      // Reorder l1 and l2 below l4
      const res = computeBatchReorderLayers(baseLayers, ['l1', 'l2'], 'l1', 'l4', 'below');
      const ids = res.map((l) => l.id);
      expect(ids).toEqual(['l3', 'l4', 'l1', 'l2', 'l5']);
    });

    it('moves multi-layer selection together above target', () => {
      // Reorder l4 and l5 above l2
      const res = computeBatchReorderLayers(baseLayers, ['l4', 'l5'], 'l4', 'l2', 'above');
      const ids = res.map((l) => l.id);
      expect(ids).toEqual(['l1', 'l4', 'l5', 'l2', 'l3']);
    });

    it('moves selected layers inside a folder and reparents them', () => {
      const layersWithFolder: LayerItem[] = [
        makeLayer('l1', 'Layer 1'),
        makeLayer('folder1', 'Folder', 'folder'),
        makeLayer('l2', 'Layer 2'),
        makeLayer('l3', 'Layer 3'),
      ];

      const res = computeBatchReorderLayers(layersWithFolder, ['l2', 'l3'], 'l2', 'folder1', 'inside');
      expect(res.find((l) => l.id === 'l2')?.parentId).toBe('folder1');
      expect(res.find((l) => l.id === 'l3')?.parentId).toBe('folder1');
    });

    it('prevents dropping a folder into itself or its descendants', () => {
      const layersWithFolder: LayerItem[] = [
        makeLayer('f1', 'Folder 1', 'folder'),
        makeLayer('c1', 'Child 1', 'raster', 'f1'),
        makeLayer('l1', 'Layer 1'),
      ];

      // Drag f1 into c1 should be a no-op
      const res = computeBatchReorderLayers(layersWithFolder, ['f1'], 'f1', 'c1', 'inside');
      expect(res).toEqual(layersWithFolder);
    });
  });
});
