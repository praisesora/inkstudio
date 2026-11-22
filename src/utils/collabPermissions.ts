import { LayerItem } from '../types/editor';
import { CollabPeer, CollabRole, MultiplayerMessage } from '../types/multiplayer';

export interface PermissionResult {
  allowed: boolean;
  reason?: string;
  blockedLayerId?: string;
  blockedLayerName?: string;
}

export function normalizeRole(role: unknown, isHost?: boolean): CollabRole {
  if (isHost || role === 'host') return 'host';
  if (role === 'viewer') return 'viewer';
  return 'editor';
}

export function peerIdEquals(
  a: string | number | undefined | null,
  b: string | number | undefined | null
): boolean {
  if (a === undefined || a === null || b === undefined || b === null) return false;
  const sa = String(a).trim();
  const sb = String(b).trim();
  return sa.length > 0 && sa === sb;
}

export function canMutateCanvas(role: CollabRole): boolean {
  return role === 'host' || role === 'editor';
}

export function canManageRoom(role: CollabRole): boolean {
  return role === 'host';
}

export function isLayerLockedByOther(
  layer: Pick<LayerItem, 'reservedByPeerId'> | null | undefined,
  myPeerId: string | number,
  myRole: CollabRole
): boolean {
  if (!layer || !layer.reservedByPeerId) return false;
  if (myRole === 'host') return false;
  return !peerIdEquals(layer.reservedByPeerId, myPeerId);
}

export function isLayerOwnedByOther(
  layer: Pick<LayerItem, 'ownerPeerId'> | null | undefined,
  myPeerId: string | number,
  myRole: CollabRole
): boolean {
  if (!layer || !layer.ownerPeerId) return false;
  if (myRole === 'host') return false;
  return !peerIdEquals(layer.ownerPeerId, myPeerId);
}

export function canEditLayer(
  layer: Pick<LayerItem, 'reservedByPeerId' | 'reservedByPeerName'> | null | undefined,
  myPeerId: string | number,
  myRole: CollabRole
): PermissionResult {
  if (!canMutateCanvas(myRole)) {
    return { allowed: false, reason: 'Viewers have read-only access' };
  }
  if (!layer) return { allowed: true };
  if (isLayerLockedByOther(layer, myPeerId, myRole)) {
    return {
      allowed: false,
      reason: `Layer is locked by ${layer.reservedByPeerName || 'its owner'}`,
    };
  }
  return { allowed: true };
}

export function canToggleLayerOwnerLock(
  layer:
    | Pick<LayerItem, 'ownerPeerId' | 'ownerPeerName' | 'reservedByPeerId' | 'reservedByPeerName'>
    | null
    | undefined,
  myPeerId: string | number,
  myRole: CollabRole
): PermissionResult {
  if (!canMutateCanvas(myRole)) {
    return { allowed: false, reason: 'Viewers cannot lock or unlock layers' };
  }
  if (!layer) {
    return { allowed: false, reason: 'Layer not found' };
  }
  if (myRole === 'host') {
    return { allowed: true };
  }
  if (layer.reservedByPeerId !== undefined && layer.reservedByPeerId !== '') {
    if (!peerIdEquals(layer.reservedByPeerId, myPeerId)) {
      return {
        allowed: false,
        reason: `Only ${layer.reservedByPeerName || 'the lock owner'} or the Host can unlock this layer`,
      };
    }
    return { allowed: true };
  }
  if (layer.ownerPeerId !== undefined && layer.ownerPeerId !== '') {
    if (!peerIdEquals(layer.ownerPeerId, myPeerId)) {
      return {
        allowed: false,
        reason: `Only ${layer.ownerPeerName || 'the layer owner'} or the Host can lock this layer`,
      };
    }
  }
  return { allowed: true };
}

function collectTargetSubtree(
  targetId: string,
  allLayers: ReadonlyArray<
    Pick<
      LayerItem,
      'id' | 'name' | 'parentId' | 'ownerPeerId' | 'ownerPeerName' | 'reservedByPeerId' | 'reservedByPeerName'
    >
  >
) {
  const byId = new Map(allLayers.map((l) => [l.id, l]));
  const root = byId.get(targetId);
  if (!root) return [];

  const collected = [root];
  const ids = new Set<string>([targetId]);
  let expanded = true;
  while (expanded) {
    expanded = false;
    for (const l of allLayers) {
      if (!ids.has(l.id) && l.parentId && ids.has(l.parentId)) {
        ids.add(l.id);
        collected.push(l);
        expanded = true;
      }
    }
  }
  return collected;
}

export function canDeleteLayer(
  layerId: string,
  allLayers: ReadonlyArray<
    Pick<
      LayerItem,
      'id' | 'name' | 'parentId' | 'ownerPeerId' | 'ownerPeerName' | 'reservedByPeerId' | 'reservedByPeerName'
    >
  >,
  myPeerId: string | number,
  myRole: CollabRole
): PermissionResult {
  if (!canMutateCanvas(myRole)) {
    return { allowed: false, reason: 'Viewers cannot delete layers' };
  }
  if (myRole === 'host') {
    return { allowed: true };
  }
  const subtree = collectTargetSubtree(layerId, allLayers);
  for (const item of subtree) {
    if (isLayerLockedByOther(item, myPeerId, myRole)) {
      return {
        allowed: false,
        reason: `Cannot delete "${item.name}" — locked by ${item.reservedByPeerName || 'another user'}`,
        blockedLayerId: item.id,
        blockedLayerName: item.name,
      };
    }
    if (isLayerOwnedByOther(item, myPeerId, myRole)) {
      return {
        allowed: false,
        reason: `Cannot delete "${item.name}" — owned by ${item.ownerPeerName || 'another user'}`,
        blockedLayerId: item.id,
        blockedLayerName: item.name,
      };
    }
  }
  return { allowed: true };
}

export function filterDeletableLayerIds(
  targetIds: ReadonlyArray<string>,
  allLayers: ReadonlyArray<
    Pick<
      LayerItem,
      'id' | 'name' | 'parentId' | 'ownerPeerId' | 'ownerPeerName' | 'reservedByPeerId' | 'reservedByPeerName'
    >
  >,
  myPeerId: string | number,
  myRole: CollabRole
): { allowedIds: string[]; blockedReasons: string[] } {
  const allowedIds: string[] = [];
  const blockedReasons: string[] = [];
  for (const id of targetIds) {
    const res = canDeleteLayer(id, allLayers, myPeerId, myRole);
    if (res.allowed) {
      allowedIds.push(id);
    } else if (res.reason) {
      blockedReasons.push(res.reason);
    }
  }
  return { allowedIds, blockedReasons };
}

/**
 * Defense-in-depth validation of incoming remote mutations on receiving clients.
 * Ensures a compromised or buggy peer cannot bypass role, lock, or ownership rules
 * even when routed through a non-authoritative relay.
 */
export function validateIncomingRemoteMutation(
  msg: MultiplayerMessage,
  senderPeer: CollabPeer | undefined,
  currentLayers: ReadonlyArray<LayerItem>
): PermissionResult {
  // Server-originated or unattributed system sync messages (no senderId) pass through
  if (msg.senderId === undefined || msg.senderId === null) {
    return { allowed: true };
  }

  const senderId = msg.senderId;
  const senderRole: CollabRole = senderPeer
    ? normalizeRole(senderPeer.role, senderPeer.isHost)
    : 'editor';

  if (senderRole === 'host') {
    return { allowed: true };
  }

  // Host-only administrative messages
  if (
    msg.type === 'PEER_ROLE_UPDATE' ||
    msg.type === 'PEER_KICK' ||
    msg.type === 'PEER_BAN' ||
    msg.type === 'PEER_UNBAN'
  ) {
    return { allowed: false, reason: 'Only the Host can manage room permissions' };
  }

  const isMutation =
    msg.type === 'STROKE_START' ||
    msg.type === 'STROKE_CHUNK' ||
    msg.type === 'STROKE_FINISH' ||
    msg.type === 'BINARY_TILE' ||
    msg.type === 'BINARY_MASK' ||
    msg.type === 'SELECTIVE_UNDO' ||
    msg.type === 'LAYER_ADD' ||
    msg.type === 'LAYER_DELETE' ||
    msg.type === 'LAYER_CLEAR' ||
    msg.type === 'LAYER_RENAME' ||
    msg.type === 'LAYER_VISIBILITY' ||
    msg.type === 'LAYER_OPACITY' ||
    msg.type === 'LAYER_UPDATE' ||
    msg.type === 'LAYER_TREE_SYNC' ||
    msg.type === 'PERSPECTIVE_RULER_SYNC' ||
    msg.type === 'STRAIGHT_RULER_SYNC' ||
    msg.type === 'ANIMATION_SYNC' ||
    msg.type === 'CANVAS_RESIZE';

  if (!isMutation) {
    return { allowed: true };
  }

  if (senderRole === 'viewer') {
    return { allowed: false, reason: 'Viewer mutation rejected' };
  }

  if (msg.type === 'LAYER_DELETE') {
    return canDeleteLayer(msg.layerId, currentLayers, senderId, senderRole);
  }

  if (msg.type === 'LAYER_TREE_SYNC') {
    const incomingIds = new Set(msg.layers.map((l) => l.id));
    for (const existing of currentLayers) {
      if (!incomingIds.has(existing.id)) {
        const delCheck = canDeleteLayer(existing.id, currentLayers, senderId, senderRole);
        if (!delCheck.allowed) return delCheck;
      } else {
        const next = msg.layers.find((l) => l.id === existing.id);
        if (next && isLayerLockedByOther(existing, senderId, senderRole)) {
          // Reject unlocking or modifying locked layer owned by someone else
          if (!peerIdEquals(next.reservedByPeerId, existing.reservedByPeerId)) {
            return { allowed: false, reason: 'Cannot unlock another user layer' };
          }
        }
      }
    }
    return { allowed: true };
  }

  if (msg.type === 'LAYER_UPDATE') {
    const target = currentLayers.find((l) => l.id === msg.layerId);
    if (!target) return { allowed: true };
    const editCheck = canEditLayer(target, senderId, senderRole);
    if (!editCheck.allowed) return editCheck;

    const clearsLock = msg.clearedFields?.includes('reservedByPeerId');
    const setsLock = msg.patch.reservedByPeerId !== undefined;
    if (clearsLock || setsLock) {
      const lockCheck = canToggleLayerOwnerLock(target, senderId, senderRole);
      if (!lockCheck.allowed) return lockCheck;
      if (setsLock && !peerIdEquals(msg.patch.reservedByPeerId, senderId)) {
        return { allowed: false, reason: 'Cannot lock layer under another peer ID' };
      }
    }
    const touchesOwner =
      msg.patch.ownerPeerId !== undefined || msg.clearedFields?.includes('ownerPeerId');
    if (touchesOwner && target.ownerPeerId && !peerIdEquals(target.ownerPeerId, senderId)) {
      return { allowed: false, reason: 'Cannot reassign layer ownership' };
    }
    return { allowed: true };
  }

  if (
    msg.type === 'LAYER_CLEAR' ||
    msg.type === 'LAYER_RENAME' ||
    msg.type === 'LAYER_VISIBILITY' ||
    msg.type === 'LAYER_OPACITY' ||
    msg.type === 'BINARY_TILE' ||
    msg.type === 'BINARY_MASK' ||
    msg.type === 'STROKE_START' ||
    msg.type === 'STROKE_FINISH'
  ) {
    const target = currentLayers.find((l) => l.id === msg.layerId);
    if (target) {
      return canEditLayer(target, senderId, senderRole);
    }
  }

  return { allowed: true };
}
