import { BlendMode, LayerItem, isFolderLikeLayer } from '../../types/editor';
import {
  AboveSliceStrategy,
  CompositingUnit,
  LayerRenderGroup,
  LayerStackPartition,
  LayerTreeNode,
  TreeNodeRenderGroup,
} from './types';

export type {
  LayerTreeNode,
  TreeNodeRenderGroup,
  LayerRenderGroup,
  CompositingUnit,
  AboveSliceStrategy,
  LayerStackPartition,
};

export function buildLayerTree(layers: LayerItem[]): LayerTreeNode[] {
  const nodeMap = new Map<string, LayerTreeNode>();
  for (const layer of layers) {
    nodeMap.set(layer.id, { layer, children: [] });
  }

  const rootNodes: LayerTreeNode[] = [];
  for (const layer of layers) {
    const node = nodeMap.get(layer.id)!;
    if (layer.parentId && nodeMap.has(layer.parentId)) {
      nodeMap.get(layer.parentId)!.children.push(node);
    } else {
      rootNodes.push(node);
    }
  }

  return rootNodes;
}

export function groupTreeNodesForCompositing(nodesBottomToTop: LayerTreeNode[]): TreeNodeRenderGroup[] {
  const groups: TreeNodeRenderGroup[] = [];
  let currentGroup: TreeNodeRenderGroup | null = null;

  for (const node of nodesBottomToTop) {
    if (node.layer.clipped && currentGroup) {
      currentGroup.clippedNodes.push(node);
    } else {
      currentGroup = {
        baseNode: node,
        clippedNodes: [],
      };
      groups.push(currentGroup);
    }
  }

  return groups;
}

/**
 * Groups consecutive clipped layers under their immediate non-clipped base layer underneath.
 * Layers are provided in bottom-to-top rendering order.
 */
export function groupLayersForCompositing(layersBottomToTop: LayerItem[]): LayerRenderGroup[] {
  const groups: LayerRenderGroup[] = [];
  let currentGroup: LayerRenderGroup | null = null;

  for (const layer of layersBottomToTop) {
    if (layer.clipped && currentGroup) {
      currentGroup.clippedLayers.push(layer);
    } else {
      currentGroup = {
        baseLayer: layer,
        clippedLayers: [],
      };
      groups.push(currentGroup);
    }
  }

  return groups;
}

function collectNodeLayerIds(node: LayerTreeNode, out: Set<string>): void {
  out.add(node.layer.id);
  for (const child of node.children) {
    collectNodeLayerIds(child, out);
  }
}

/**
 * Flattens pass-through folders into a bottom-to-top sequence of atomic compositing units
 * while keeping isolated folders and clipping-mask groups atomic.
 */
export function flattenLayerTreeToUnits(
  nodes: LayerTreeNode[],
  inheritedOpacity: number = 1.0
): CompositingUnit[] {
  const units: CompositingUnit[] = [];
  const siblingsBottomToTop = nodes.slice().reverse();
  const groups = groupTreeNodesForCompositing(siblingsBottomToTop);

  for (const group of groups) {
    const baseLayer = group.baseNode.layer;
    if (!baseLayer.visible || baseLayer.opacity <= 0.001) {
      continue;
    }

    if (baseLayer.type === 'folder' && baseLayer.blendMode === 'pass-through') {
      const nested = flattenLayerTreeToUnits(
        group.baseNode.children,
        inheritedOpacity * baseLayer.opacity
      );
      for (const u of nested) {
        units.push(u);
      }
      continue;
    }

    const containedLayerIds = new Set<string>();
    collectNodeLayerIds(group.baseNode, containedLayerIds);
    for (const cn of group.clippedNodes) {
      collectNodeLayerIds(cn, containedLayerIds);
    }

    units.push({
      group,
      inheritedOpacity,
      containedLayerIds,
    });
  }

  return units;
}

/**
 * Returns true if a compositing unit is strictly Porter-Duff source-over associative
 * with respect to the backdrop below it (safe to pre-bake onto transparent FBO and composite with 'normal').
 */
export function isUnitNormalAssociative(unit: CompositingUnit): boolean {
  const baseLayer = unit.group.baseNode.layer;
  if (baseLayer.type === 'adjustment') {
    return false;
  }
  if (baseLayer.type === 'folder' || baseLayer.type === 'frame-folder') {
    // Pass-through regular folders were flattened; isolated folders and frame-folders
    // isolate their children's blend modes, so normal/pass-through is normal-associative.
    return baseLayer.blendMode === 'normal' || baseLayer.blendMode === 'pass-through';
  }
  if (baseLayer.blendMode !== 'normal' && baseLayer.blendMode !== 'pass-through') {
    return false;
  }
  for (const cn of unit.group.clippedNodes) {
    const cl = cn.layer;
    if (!cl.visible || cl.opacity <= 0.001 || isFolderLikeLayer(cl)) continue;
    if (cl.blendMode !== 'normal' && cl.blendMode !== 'pass-through') {
      return false;
    }
  }
  return true;
}

/**
 * Returns the blend mode if a single non-associative unit can be baked onto transparent
 * with 'normal' and composited over (below + active) using a single ping-pong blend pass.
 */
export function canSingleUnitBakeWithBlendMode(unit: CompositingUnit): BlendMode | null {
  const baseLayer = unit.group.baseNode.layer;
  if (baseLayer.type === 'adjustment') {
    return null;
  }
  if (baseLayer.type === 'folder' || baseLayer.type === 'frame-folder') {
    if (baseLayer.blendMode !== 'normal' && baseLayer.blendMode !== 'pass-through') {
      return baseLayer.blendMode;
    }
    return null;
  }
  const visibleClipped = unit.group.clippedNodes.filter(
    (cn) => cn.layer.visible && cn.layer.opacity > 0.001 && !isFolderLikeLayer(cn.layer)
  );
  if (
    visibleClipped.length === 0 &&
    baseLayer.blendMode !== 'normal' &&
    baseLayer.blendMode !== 'pass-through'
  ) {
    return baseLayer.blendMode;
  }
  return null;
}

/**
 * Partitions the visible layer stack into `below`, `active`, and `above` slices relative to `activeLayerId`.
 */
export function partitionLayerStack(
  layers: LayerItem[],
  activeLayerId?: string | null
): LayerStackPartition {
  const tree = buildLayerTree(layers);
  const units = flattenLayerTreeToUnits(tree, 1.0);

  let activeIdx = -1;
  if (activeLayerId) {
    for (let i = 0; i < units.length; i++) {
      if (units[i].containedLayerIds.has(activeLayerId)) {
        activeIdx = i;
        break;
      }
    }
  }

  if (activeIdx === -1) {
    return {
      belowUnits: units,
      activeUnit: null,
      aboveDynamicUnits: [],
      aboveCachedUnits: [],
      aboveStrategy: 'empty',
      aboveCacheBlendMode: 'normal',
    };
  }

  const belowUnits = units.slice(0, activeIdx);
  const activeUnit = units[activeIdx];
  const aboveAll = units.slice(activeIdx + 1);

  if (aboveAll.length === 0) {
    return {
      belowUnits,
      activeUnit,
      aboveDynamicUnits: [],
      aboveCachedUnits: [],
      aboveStrategy: 'empty',
      aboveCacheBlendMode: 'normal',
    };
  }

  let lastNonAssocIdx = -1;
  for (let i = 0; i < aboveAll.length; i++) {
    if (!isUnitNormalAssociative(aboveAll[i])) {
      lastNonAssocIdx = i;
    }
  }

  if (lastNonAssocIdx === -1) {
    return {
      belowUnits,
      activeUnit,
      aboveDynamicUnits: [],
      aboveCachedUnits: aboveAll,
      aboveStrategy: 'baked-normal',
      aboveCacheBlendMode: 'normal',
    };
  }

  if (aboveAll.length === 1) {
    const singleBlend = canSingleUnitBakeWithBlendMode(aboveAll[0]);
    if (singleBlend) {
      return {
        belowUnits,
        activeUnit,
        aboveDynamicUnits: [],
        aboveCachedUnits: aboveAll,
        aboveStrategy: 'baked-single-blend',
        aboveCacheBlendMode: singleBlend,
      };
    }
  }

  return {
    belowUnits,
    activeUnit,
    aboveDynamicUnits: aboveAll.slice(0, lastNonAssocIdx + 1),
    aboveCachedUnits: aboveAll.slice(lastNonAssocIdx + 1),
    aboveStrategy: 'mixed',
    aboveCacheBlendMode: 'normal',
  };
}
