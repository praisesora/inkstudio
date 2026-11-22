import { Dispatch, MutableRefObject, SetStateAction } from 'react';
import {
  CanvasDimensions,
  LayerItem,
} from '../../types/editor';
import { SparseTileGrid } from '../../utils/tileEngine';

export interface UseLayerManagerProps {
  dimensions: CanvasDimensions;
  activeSessionId?: string | null;
  tileGrid?: SparseTileGrid;
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
}

export interface LayerCanvasRegistryApi {
  updateLayerThumbnail: (id: string, immediate?: boolean) => void;
}
