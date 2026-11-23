import { Dispatch, MutableRefObject, SetStateAction } from 'react';
import {
  CanvasDimensions,
  HistoryActionType,
  LayerItem,
  LayerTreeDelta,
  TileDelta,
} from '../../types/editor';
import { SparseTileGrid } from '../../utils/tileEngine';
import type { PushHistoryStepFn } from '../drawing/types';

export interface UseLayerManagerProps {
  dimensions: CanvasDimensions;
  activeSessionId?: string | null;
  tileGrid?: SparseTileGrid;
  pushHistoryStepRef?: MutableRefObject<PushHistoryStepFn | null | undefined>;
}

export interface LayerManagerContext {
  dimensions: CanvasDimensions;
  activeTileGridRef: MutableRefObject<SparseTileGrid>;
  dimensionsRef: MutableRefObject<CanvasDimensions>;
  activeSessionIdRef: MutableRefObject<string | null>;
  defaultToneFrequencyRef: MutableRefObject<number>;
  thumbDebounceTimersRef: MutableRefObject<Map<string, ReturnType<typeof setTimeout>>>;
  layers: LayerItem[];
  setLayers: Dispatch<SetStateAction<LayerItem[]>>;
  layersRef: MutableRefObject<LayerItem[]>;
  activeLayerId: string;
  setActiveLayerId: (id: string) => void;
  activeLayerIdRef: MutableRefObject<string>;
  selectedLayerIds: string[];
  setSelectedLayerIds: (ids: string[] | ((prev: string[]) => string[])) => void;
  selectedLayerIdsRef: MutableRefObject<string[]>;
  suppressHistoryDepthRef: MutableRefObject<number>;
  recordLayerHistory: (
    label: string,
    targetLayerId: string,
    layerTreeDelta?: LayerTreeDelta,
    tileDeltas?: TileDelta[],
    actionType?: HistoryActionType
  ) => void;
}

export interface LayerCanvasRegistryApi {
  updateLayerThumbnail: (id: string, immediate?: boolean) => void;
}
