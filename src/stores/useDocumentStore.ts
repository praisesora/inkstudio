import {
  CanvasDimensions,
  CanvasColorMode,
  DocumentTab,
  SoftProofSettings,
  DEFAULT_SOFT_PROOF_SETTINGS,
  CmykStandard,
  AnimationTimeline,
} from '../types/editor';
import { PerspectiveRuler, StraightRuler, ConstraintAxis } from '../types/perspective';
import { createDefaultStraightRuler } from '../utils/straightRulerMath';
import { SavedFileInfo } from '../utils/saveManager';
import { createStore } from './createStore';

export const INITIAL_CANVAS_DIMENSIONS: CanvasDimensions = {
  width: 1440,
  height: 900,
  dpi: 300,
};

export interface DocumentStoreState {
  documents: DocumentTab[];
  activeDocumentId: string | null;
  dimensions: CanvasDimensions;
  colorMode: CanvasColorMode;
  documentName: string;
  activeLayerId: string;
  activeEditTarget: 'layer' | 'mask';
  savedFileInfo: SavedFileInfo | null;
  softProofSettings: SoftProofSettings;
  animationTimeline: AnimationTimeline | null;
  perspectiveRuler: PerspectiveRuler | null;
  straightRuler: StraightRuler | null;
  activeLockedAxis: ConstraintAxis | null;
}

const createInitialDocumentState = (): DocumentStoreState => ({
  documents: [],
  activeDocumentId: null,
  dimensions: { ...INITIAL_CANVAS_DIMENSIONS },
  colorMode: 'color',
  documentName: '',
  activeLayerId: '',
  activeEditTarget: 'layer',
  savedFileInfo: null,
  softProofSettings: { ...DEFAULT_SOFT_PROOF_SETTINGS },
  animationTimeline: null,
  perspectiveRuler: null,
  straightRuler: null,
  activeLockedAxis: null,
});

export const useDocumentStore = createStore<DocumentStoreState>(createInitialDocumentState);

export const documentStoreActions = {
  setDocuments(updater: DocumentTab[] | ((prev: DocumentTab[]) => DocumentTab[])): void {
    useDocumentStore.setState((prev) => ({
      documents: typeof updater === 'function' ? updater(prev.documents) : updater,
    }));
  },

  setActiveDocumentId(id: string | null): void {
    useDocumentStore.setState({ activeDocumentId: id });
  },

  markDocumentDirty(id: string | null, isDirty: boolean): void {
    if (!id) return;
    useDocumentStore.setState((prev) => {
      const target = prev.documents.find((d) => d.id === id);
      if (!target || Boolean(target.isDirty) === isDirty) return prev;
      return {
        documents: prev.documents.map((d) => (d.id === id ? { ...d, isDirty } : d)),
      };
    });
  },

  setDimensions(dimensions: CanvasDimensions): void {
    useDocumentStore.setState({ dimensions });
  },

  setColorMode(colorMode: CanvasColorMode): void {
    useDocumentStore.setState({ colorMode });
  },

  setDocumentName(documentName: string): void {
    useDocumentStore.setState({ documentName });
  },

  setActiveLayerId(activeLayerId: string): void {
    useDocumentStore.setState({ activeLayerId });
  },

  setActiveEditTarget(activeEditTarget: 'layer' | 'mask'): void {
    useDocumentStore.setState({ activeEditTarget });
  },

  setSavedFileInfo(savedFileInfo: SavedFileInfo | null): void {
    useDocumentStore.setState({ savedFileInfo });
  },

  toggleSoftProof(): void {
    useDocumentStore.setState((prev) => ({
      softProofSettings: {
        ...prev.softProofSettings,
        enabled: !prev.softProofSettings.enabled,
      },
    }));
  },

  toggleGamutWarning(): void {
    useDocumentStore.setState((prev) => ({
      softProofSettings: {
        ...prev.softProofSettings,
        gamutWarning: !prev.softProofSettings.gamutWarning,
      },
    }));
  },

  setProofStandard(standard: CmykStandard): void {
    useDocumentStore.setState((prev) => ({
      softProofSettings: {
        ...prev.softProofSettings,
        standard,
      },
    }));
  },

  setAnimationTimeline(animationTimeline: AnimationTimeline | null): void {
    useDocumentStore.setState({ animationTimeline });
  },

  setPerspectiveRuler(
    updater:
      | PerspectiveRuler
      | null
      | ((prev: PerspectiveRuler | null) => PerspectiveRuler | null)
  ): void {
    useDocumentStore.setState((prev) => {
      const next = typeof updater === 'function' ? updater(prev.perspectiveRuler) : updater;
      if (prev.activeDocumentId) {
        return {
          perspectiveRuler: next,
          documents: prev.documents.map((d) =>
            d.id === prev.activeDocumentId ? { ...d, perspectiveRuler: next } : d
          ),
        };
      }
      return { perspectiveRuler: next };
    });
  },

  setStraightRuler(
    updater:
      | StraightRuler
      | null
      | ((prev: StraightRuler | null) => StraightRuler | null)
  ): void {
    useDocumentStore.setState((prev) => {
      const next = typeof updater === 'function' ? updater(prev.straightRuler) : updater;
      if (prev.activeDocumentId) {
        return {
          straightRuler: next,
          documents: prev.documents.map((d) =>
            d.id === prev.activeDocumentId ? { ...d, straightRuler: next } : d
          ),
        };
      }
      return { straightRuler: next };
    });
  },

  toggleStraightRuler(centerX?: number, centerY?: number): StraightRuler {
    const state = useDocumentStore.getState();
    const cx = centerX ?? state.dimensions.width * 0.5;
    const cy = centerY ?? state.dimensions.height * 0.5;
    const prev = state.straightRuler;
    const next: StraightRuler = prev
      ? { ...prev, enabled: !prev.enabled }
      : createDefaultStraightRuler(cx, cy);
    documentStoreActions.setStraightRuler(next);
    return next;
  },

  setActiveLockedAxis(newAxis: ConstraintAxis | null): void {
    const prev = useDocumentStore.getState().activeLockedAxis;
    if (prev === newAxis) return;
    if (
      prev &&
      newAxis &&
      prev.type === newAxis.type &&
      prev.origin.x === newAxis.origin.x &&
      prev.origin.y === newAxis.origin.y &&
      prev.dir.x === newAxis.dir.x &&
      prev.dir.y === newAxis.dir.y
    ) {
      return;
    }
    useDocumentStore.setState({ activeLockedAxis: newAxis });
  },
};

export function selectHasOpenDocument(state: DocumentStoreState): boolean {
  return Boolean(
    state.activeDocumentId && state.documents.some((d) => d.id === state.activeDocumentId)
  );
}
