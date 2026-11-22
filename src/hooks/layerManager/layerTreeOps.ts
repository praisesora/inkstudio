import { LayerItem, isFolderLikeLayer } from '../../types/editor';

export function isBackgroundLayerId(id: string): boolean {
  return id === 'layer-bg' || id.startsWith('layer-bg');
}

// Helper to generate the next collaborative layer name (e.g. "Artist 1", "Artist 2", "Alex 1")
export function getNextCollabLayerName(username: string, layers: LayerItem[]): string {
  const cleanName = (username || 'User').trim();
  let maxNum = 0;
  const escaped = cleanName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const regex = new RegExp(`^${escaped}\\s*(\\d*)$`, 'i');

  layers.forEach((l) => {
    const match = l.name.match(regex);
    if (match) {
      const num = match[1] ? parseInt(match[1], 10) : 1;
      if (!isNaN(num) && num > maxNum) {
        maxNum = num;
      }
    }
  });

  return `${cleanName} ${maxNum + 1}`;
}

// Pure selection computation for single, Shift (range), and Ctrl/Cmd (toggle) clicks
export function computeLayerSelection(
  layers: LayerItem[],
  currentSelectedIds: string[],
  activeId: string,
  pivotId: string | null,
  targetId: string,
  isShift: boolean,
  isCtrl: boolean
): { nextSelectedIds: string[]; nextActiveId: string; nextPivotId: string } {
  const targetIndex = layers.findIndex((l) => l.id === targetId);
  if (targetIndex === -1) {
    return {
      nextSelectedIds: currentSelectedIds,
      nextActiveId: activeId,
      nextPivotId: pivotId || activeId,
    };
  }

  if (isShift) {
    const effectivePivot = pivotId || activeId || targetId;
    const pivotIndex = layers.findIndex((l) => l.id === effectivePivot);
    const safePivotIdx = pivotIndex >= 0 ? pivotIndex : targetIndex;
    const start = Math.min(safePivotIdx, targetIndex);
    const end = Math.max(safePivotIdx, targetIndex);
    const rangeIds = layers.slice(start, end + 1).map((l) => l.id);

    if (isCtrl) {
      return {
        nextSelectedIds: Array.from(new Set([...currentSelectedIds, ...rangeIds])),
        nextActiveId: targetId,
        nextPivotId: effectivePivot,
      };
    } else {
      return {
        nextSelectedIds: rangeIds,
        nextActiveId: targetId,
        nextPivotId: effectivePivot,
      };
    }
  } else if (isCtrl) {
    const exists = currentSelectedIds.includes(targetId);
    if (exists) {
      const next = currentSelectedIds.filter((item) => item !== targetId);
      const nextActive = activeId === targetId && next.length > 0 ? next[next.length - 1] : activeId;
      return {
        nextSelectedIds: next,
        nextActiveId: nextActive,
        nextPivotId: targetId,
      };
    } else {
      return {
        nextSelectedIds: [...currentSelectedIds, targetId],
        nextActiveId: targetId,
        nextPivotId: targetId,
      };
    }
  } else {
    return {
      nextSelectedIds: [targetId],
      nextActiveId: targetId,
      nextPivotId: targetId,
    };
  }
}

// Pure batch deletion helper
export function computeBatchDeleteLayers(
  layers: LayerItem[],
  selectedIds: string[],
  activeId: string
): { nextLayers: LayerItem[]; deletedIds: string[]; nextActiveId: string } {
  let targets = [...selectedIds];
  if (targets.length === 0 && activeId) {
    targets = [activeId];
  }
  if (targets.length === 0) {
    return { nextLayers: layers, deletedIds: [], nextActiveId: activeId };
  }

  const targetSet = new Set(targets);
  const allToDelete = new Set<string>();

  const collectDescendants = (parentId: string) => {
    for (const l of layers) {
      if (l.parentId === parentId) {
        allToDelete.add(l.id);
        if (isFolderLikeLayer(l)) collectDescendants(l.id);
      }
    }
  };

  for (const id of targetSet) {
    allToDelete.add(id);
    const item = layers.find((l) => l.id === id);
    if (isFolderLikeLayer(item)) {
      collectDescendants(id);
    }
  }

  // Ensure we don't delete all raster layers if user tries to delete everything
  const remainingRaster = layers.filter((l) => l.type === 'raster' && !allToDelete.has(l.id));
  if (remainingRaster.length === 0) {
    const preserved = layers.find((l) => l.id === 'layer-bg' || l.id.startsWith('layer-bg')) || layers.find((l) => l.type === 'raster');
    if (preserved) {
      allToDelete.delete(preserved.id);
    }
  }

  const nextLayers = layers.filter((l) => !allToDelete.has(l.id));
  const nextActive = nextLayers.find((l) => l.type === 'raster') || nextLayers[0];
  const nextActiveId = nextActive ? nextActive.id : '';

  return {
    nextLayers,
    deletedIds: Array.from(allToDelete),
    nextActiveId,
  };
}

// Pure group selected layers helper
export function computeGroupLayers(
  layers: LayerItem[],
  selectedIds: string[],
  activeId: string,
  customFolderId?: string
): { nextLayers: LayerItem[]; newFolder: LayerItem } | null {
  let targets = [...selectedIds];
  if (targets.length === 0 && activeId) {
    targets = [activeId];
  }
  if (targets.length === 0) return null;

  const targetSet = new Set(targets);
  const selectedItems = layers.filter((l) => targetSet.has(l.id));
  if (selectedItems.length === 0) return null;

  const indices = selectedItems.map((l) => layers.indexOf(l)).filter((idx) => idx >= 0);
  const minIdx = Math.min(...indices);

  const firstParent = selectedItems[0].parentId;
  const allSameParent = selectedItems.every((l) => l.parentId === firstParent);
  const folderParentId = allSameParent ? firstParent : null;

  const folderId = customFolderId || `folder-${Date.now()}-${Math.random().toString(36).substring(2, 6)}`;
  let count = 1;
  layers.forEach((l) => {
    if (l.type === 'folder' && l.name.startsWith('Folder ')) {
      const num = parseInt(l.name.replace('Folder ', ''), 10);
      if (!isNaN(num) && num >= count) count = num + 1;
    }
  });

  const newFolder: LayerItem = {
    id: folderId,
    name: `Folder ${count}`,
    type: 'folder',
    visible: true,
    opacity: 1,
    blendMode: 'pass-through',
    locked: false,
    collapsed: false,
    parentId: folderParentId,
    thumbnailUrl: '',
  };

  const movingIds = new Set<string>();
  const getDescendants = (parentId: string) => {
    for (const l of layers) {
      if (l.parentId === parentId) {
        movingIds.add(l.id);
        if (isFolderLikeLayer(l)) getDescendants(l.id);
      }
    }
  };
  for (const item of selectedItems) {
    movingIds.add(item.id);
    if (isFolderLikeLayer(item)) getDescendants(item.id);
  }

  const movingItems = layers
    .filter((l) => movingIds.has(l.id))
    .map((l) => {
      if (!l.parentId || !movingIds.has(l.parentId)) {
        return { ...l, parentId: folderId };
      }
      return l;
    });

  const remaining = layers.filter((l) => !movingIds.has(l.id));
  const targetInsertIdx = Math.min(minIdx, remaining.length);

  const nextLayers = [
    ...remaining.slice(0, targetInsertIdx),
    newFolder,
    ...movingItems,
    ...remaining.slice(targetInsertIdx),
  ];

  return { nextLayers, newFolder };
}

// Pure drag-and-drop / reordering helper
export function computeBatchReorderLayers(
  layers: LayerItem[],
  selectedIds: string[],
  draggedId: string,
  targetId: string,
  position: 'above' | 'below' | 'inside'
): LayerItem[] {
  if (draggedId === targetId) return layers;

  const isMultiDrag = selectedIds.length > 1 && selectedIds.includes(draggedId);
  const rootIds = isMultiDrag ? selectedIds : [draggedId];

  const targetIdx = layers.findIndex((l) => l.id === targetId);
  if (targetIdx < 0) return layers;
  const targetItem = layers[targetIdx];

  const getDescendantIds = (parentId: string): string[] => {
    const ids: string[] = [];
    for (const item of layers) {
      if (item.parentId === parentId) {
        ids.push(item.id);
        ids.push(...getDescendantIds(item.id));
      }
    }
    return ids;
  };

  const movingIds = new Set<string>();
  for (const id of rootIds) {
    movingIds.add(id);
    const item = layers.find((l) => l.id === id);
    if (isFolderLikeLayer(item)) {
      getDescendantIds(id).forEach((descId) => movingIds.add(descId));
    }
  }

  if (movingIds.has(targetId)) return layers;

  let currCheck: LayerItem | undefined = targetItem;
  while (currCheck) {
    if (movingIds.has(currCheck.id)) return layers;
    currCheck = layers.find((l) => l.id === currCheck?.parentId);
  }

  const newParentId = (position === 'inside' && isFolderLikeLayer(targetItem))
    ? targetItem.id
    : targetItem.parentId;

  const movingItems = layers
    .filter((l) => movingIds.has(l.id))
    .map((l) => {
      if (!l.parentId || !movingIds.has(l.parentId)) {
        return { ...l, parentId: newParentId };
      }
      return l;
    });

  const remaining = layers.filter((l) => !movingIds.has(l.id));
  const newTargetIdx = remaining.findIndex((l) => l.id === targetId);
  if (newTargetIdx < 0) return layers;

  let insertIdx = newTargetIdx;
  if (position === 'above') {
    insertIdx = newTargetIdx;
  } else if (position === 'below' || position === 'inside') {
    insertIdx = newTargetIdx + 1;
  }

  remaining.splice(insertIdx, 0, ...movingItems);
  return remaining;
}

// Pure batch visibility toggle
export function computeBatchVisibility(
  layers: LayerItem[],
  selectedIds: string[],
  targetId: string
): LayerItem[] {
  const isMulti = selectedIds.length > 1 && selectedIds.includes(targetId);
  if (!isMulti) {
    return layers.map((l) => (l.id === targetId ? { ...l, visible: !l.visible } : l));
  }
  const target = layers.find((l) => l.id === targetId);
  const newVisible = target ? !target.visible : true;
  const selectedSet = new Set(selectedIds);
  return layers.map((l) => (selectedSet.has(l.id) ? { ...l, visible: newVisible } : l));
}

// Pure batch lock toggle
export function computeBatchLock(
  layers: LayerItem[],
  selectedIds: string[],
  targetId: string
): LayerItem[] {
  const isMulti = selectedIds.length > 1 && selectedIds.includes(targetId);
  if (!isMulti) {
    return layers.map((l) => (l.id === targetId ? { ...l, locked: !l.locked } : l));
  }
  const target = layers.find((l) => l.id === targetId);
  const newLocked = target ? !target.locked : true;
  const selectedSet = new Set(selectedIds);
  return layers.map((l) => (selectedSet.has(l.id) ? { ...l, locked: newLocked } : l));
}
