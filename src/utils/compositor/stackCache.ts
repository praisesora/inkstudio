import { LayerItem, resolveToneDensityType } from '../../types/editor';
import { hasActiveLayerStyles } from './shaders/effectShaders';
import { partitionLayerStack } from './layerTree';
import {
  CompositingUnit,
  LayerStackCacheEvaluation,
  LayerStackCacheInput,
  LayerStackCacheTrackerLike,
  LayerTreeNode,
} from './types';

export type { LayerStackCacheInput, LayerStackCacheEvaluation };

function serializeLayerNodeSignature(
  node: LayerTreeNode,
  inheritedOpacity: number,
  getLayerContentVersion: (layerId: string) => number,
  getMaskInvalidationEpoch?: (layerId: string) => number
): string {
  const l = node.layer;
  const contentVer = getLayerContentVersion(l.id);
  const maskEpoch = getMaskInvalidationEpoch ? getMaskInvalidationEpoch(l.id) : 0;
  const stylesSig = hasActiveLayerStyles(l.styles) ? JSON.stringify(l.styles) : '';
  const adjSig = l.type === 'adjustment' && l.adjustmentData ? JSON.stringify(l.adjustmentData) : '';
  const toneSig = l.toneEnabled
    ? `1:${l.toneFrequency ?? 60}:${l.toneAngle ?? 45}:${l.toneDotShape ?? ''}:${l.toneDensity ?? 40}:${resolveToneDensityType(l)}`
    : '0';
  const tintSig = l.layerColorEnabled
    ? `1:${l.layerColor ?? ''}:${l.layerSubColor ?? ''}`
    : '0';
  const maskSig = l.maskCanvas && l.maskEnabled !== false
    ? `1:${l.maskVersion ?? 0}:${maskEpoch}:${l.maskCanvas.width}x${l.maskCanvas.height}`
    : '0';
  const exprSig = `${l.expressionColor ?? 'color'}:${l.monoThreshold ?? 128}:${l.monoExpressBlack !== false ? 1 : 0}:${l.monoExpressWhite !== false ? 1 : 0}`;
  const frameSig = l.type === 'frame-folder' && l.comicFrames ? JSON.stringify(l.comicFrames) : '';

  let sig = `${l.id}|${l.type}|${l.visible ? 1 : 0}|${l.opacity}|${inheritedOpacity}|${l.blendMode}|${l.clipped ? 1 : 0}|v:${contentVer}|m:${maskSig}|t:${toneSig}|c:${tintSig}|e:${exprSig}|s:${stylesSig}|a:${adjSig}|f:${frameSig}`;

  if (node.children.length > 0) {
    const childSigs: string[] = [];
    for (const child of node.children) {
      if (!child.layer.visible || child.layer.opacity <= 0.001) continue;
      childSigs.push(
        serializeLayerNodeSignature(child, 1.0, getLayerContentVersion, getMaskInvalidationEpoch)
      );
    }
    sig += `[${childSigs.join(',')}]`;
  }

  return sig;
}

function serializeUnitSignature(
  unit: CompositingUnit,
  getLayerContentVersion: (layerId: string) => number,
  getMaskInvalidationEpoch?: (layerId: string) => number
): string {
  let sig = serializeLayerNodeSignature(
    unit.group.baseNode,
    unit.inheritedOpacity,
    getLayerContentVersion,
    getMaskInvalidationEpoch
  );
  if (unit.group.clippedNodes.length > 0) {
    const clippedSigs: string[] = [];
    for (const cn of unit.group.clippedNodes) {
      if (!cn.layer.visible || cn.layer.opacity <= 0.001 || cn.layer.type === 'folder') continue;
      clippedSigs.push(
        serializeLayerNodeSignature(cn, unit.inheritedOpacity, getLayerContentVersion, getMaskInvalidationEpoch)
      );
    }
    if (clippedSigs.length > 0) {
      sig += `{clip:${clippedSigs.join(';')}}`;
    }
  }
  return sig;
}

/**
 * Pure invalidation tracker for the Baked Layer Stack Cache (`belowActiveCacheFbo` & `aboveActiveCacheFbo`).
 * Determines independently whether the lower or upper cached FBO needs rebuilding.
 */
export class LayerStackCacheTracker implements LayerStackCacheTrackerLike {
  private lastBelowSignature: string | null = null;
  private lastAboveSignature: string | null = null;

  public evaluate(input: LayerStackCacheInput): LayerStackCacheEvaluation {
    const partition = partitionLayerStack(input.layers, input.activeLayerId);

    const { transform, dimensions } = input;
    const viewportSig =
      `${input.viewportW}x${input.viewportH}@${input.dpr}|` +
      `${dimensions.width}x${dimensions.height}@${dimensions.dpi ?? 600}|` +
      `${transform.pan.x},${transform.pan.y},${transform.zoom},${transform.rotation},` +
      `${transform.flipX ? 1 : 0},${transform.flipY ? 1 : 0}|g:${input.gridId ?? 0}|ep:${input.gridEpoch ?? 0}`;

    // Onion skin frames are baked into the below cache right after the artboard background
    let onionSig = '';
    if (input.onionSkinFrames && input.onionSkinFrames.length > 0) {
      const layerMap = new Map<string, LayerItem>();
      for (const l of input.layers) layerMap.set(l.id, l);
      const parts: string[] = [];
      for (const frame of input.onionSkinFrames) {
        const target = layerMap.get(frame.layerId);
        if (target && target.visible) {
          parts.push(
            `${frame.layerId}:${frame.tint}:${frame.opacity}:v${input.getLayerContentVersion(frame.layerId)}`
          );
        }
      }
      onionSig = parts.join(',');
    }

    const modeTag = input.colorMode ?? 'color';
    const belowUnitSigs = partition.belowUnits.map((u) =>
      serializeUnitSignature(u, input.getLayerContentVersion, input.getMaskInvalidationEpoch)
    );
    const belowSignature = `${viewportSig}|cm:${modeTag}|cb:${input.showCheckerboard ? 1 : 0}|tb:${input.transparentBackground ? 1 : 0}|os:${onionSig}|below:[${belowUnitSigs.join('||')}]`;

    let aboveSignature = '';
    if (partition.aboveCachedUnits.length > 0) {
      const aboveUnitSigs = partition.aboveCachedUnits.map((u) =>
        serializeUnitSignature(u, input.getLayerContentVersion, input.getMaskInvalidationEpoch)
      );
      aboveSignature = `${viewportSig}|cm:${modeTag}|strat:${partition.aboveStrategy}:${partition.aboveCacheBlendMode}|above:[${aboveUnitSigs.join('||')}]`;
    }

    const belowDirty = belowSignature !== this.lastBelowSignature;
    const aboveDirty =
      partition.aboveCachedUnits.length > 0 && aboveSignature !== this.lastAboveSignature;

    return {
      partition,
      belowSignature,
      aboveSignature,
      belowDirty,
      aboveDirty,
    };
  }

  public commit(belowSignature: string, aboveSignature: string): void {
    this.lastBelowSignature = belowSignature;
    this.lastAboveSignature = aboveSignature;
  }

  public invalidateAll(): void {
    this.lastBelowSignature = null;
    this.lastAboveSignature = null;
  }

  public invalidateBelow(): void {
    this.lastBelowSignature = null;
  }

  public invalidateAbove(): void {
    this.lastAboveSignature = null;
  }

  public getLastSignatures(): { below: string | null; above: string | null } {
    return { below: this.lastBelowSignature, above: this.lastAboveSignature };
  }
}
