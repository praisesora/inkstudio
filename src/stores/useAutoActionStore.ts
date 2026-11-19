import { createStore } from './createStore';
import {
  AutoAction,
  AutoActionCommandType,
  AutoActionSet,
  loadAutoActionSets,
  makeActionStep,
  saveAutoActionSets,
} from '../utils/autoActionEngine';

export interface AutoActionStoreState {
  sets: AutoActionSet[];
  activeSetId: string;
  selectedActionId: string | null;
  isRecording: boolean;
  recordingActionId: string | null;
  isPlaying: boolean;
}

const createInitialAutoActionState = (): AutoActionStoreState => {
  const sets = loadAutoActionSets();
  const activeSet = sets[0];
  return {
    sets,
    activeSetId: activeSet?.id ?? 'set-manga-default',
    selectedActionId: activeSet?.actions[0]?.id ?? null,
    isRecording: false,
    recordingActionId: null,
    isPlaying: false,
  };
};

export const useAutoActionStore = createStore<AutoActionStoreState>(createInitialAutoActionState);

function persist(sets: AutoActionSet[]): void {
  saveAutoActionSets(sets);
}

export const autoActionStoreActions = {
  selectSet(setId: string): void {
    const state = useAutoActionStore.getState();
    const found = state.sets.find((s) => s.id === setId);
    if (!found) return;
    useAutoActionStore.setState({
      activeSetId: setId,
      selectedActionId: found.actions[0]?.id ?? null,
    });
  },

  selectAction(actionId: string | null): void {
    useAutoActionStore.setState({ selectedActionId: actionId });
  },

  createSet(name: string): AutoActionSet {
    const clean = name.trim() || `Action Set ${useAutoActionStore.getState().sets.length + 1}`;
    const newSet: AutoActionSet = {
      id: `set-${Date.now()}-${Math.random().toString(36).substring(2, 6)}`,
      name: clean,
      actions: [],
    };
    useAutoActionStore.setState((prev) => {
      const sets = [...prev.sets, newSet];
      persist(sets);
      return { sets, activeSetId: newSet.id, selectedActionId: null };
    });
    return newSet;
  },

  createAction(name?: string, setId?: string): AutoAction {
    const state = useAutoActionStore.getState();
    const targetSetId = setId ?? state.activeSetId;
    const targetSet = state.sets.find((s) => s.id === targetSetId) ?? state.sets[0];
    const cleanName =
      name?.trim() || `Auto Action ${(targetSet?.actions.length ?? 0) + 1}`;
    const action: AutoAction = {
      id: `action-${Date.now()}-${Math.random().toString(36).substring(2, 6)}`,
      name: cleanName,
      steps: [],
      createdAt: Date.now(),
    };
    useAutoActionStore.setState((prev) => {
      const sets = prev.sets.map((s) =>
        s.id === targetSet.id ? { ...s, actions: [...s.actions, action] } : s
      );
      persist(sets);
      return { sets, selectedActionId: action.id };
    });
    return action;
  },

  deleteAction(actionId: string): void {
    useAutoActionStore.setState((prev) => {
      const sets = prev.sets.map((s) => ({
        ...s,
        actions: s.actions.filter((a) => a.id !== actionId),
      }));
      persist(sets);
      const isRecTarget = prev.recordingActionId === actionId;
      return {
        sets,
        selectedActionId: prev.selectedActionId === actionId ? null : prev.selectedActionId,
        isRecording: isRecTarget ? false : prev.isRecording,
        recordingActionId: isRecTarget ? null : prev.recordingActionId,
      };
    });
  },

  startRecording(actionId?: string): string {
    const state = useAutoActionStore.getState();
    let targetId = actionId ?? state.selectedActionId;
    if (!targetId) {
      const created = autoActionStoreActions.createAction();
      targetId = created.id;
    }
    useAutoActionStore.setState({
      isRecording: true,
      recordingActionId: targetId,
      selectedActionId: targetId,
    });
    return targetId;
  },

  stopRecording(): void {
    useAutoActionStore.setState({
      isRecording: false,
      recordingActionId: null,
    });
  },

  recordStep(
    type: AutoActionCommandType,
    label: string,
    params: Record<string, unknown> = {}
  ): void {
    const state = useAutoActionStore.getState();
    if (!state.isRecording || !state.recordingActionId || state.isPlaying) return;
    const step = makeActionStep(type, label, params);
    useAutoActionStore.setState((prev) => {
      const sets = prev.sets.map((s) => ({
        ...s,
        actions: s.actions.map((a) =>
          a.id === prev.recordingActionId ? { ...a, steps: [...a.steps, step] } : a
        ),
      }));
      persist(sets);
      return { sets };
    });
  },

  toggleStepEnabled(actionId: string, stepId: string): void {
    useAutoActionStore.setState((prev) => {
      const sets = prev.sets.map((s) => ({
        ...s,
        actions: s.actions.map((a) =>
          a.id === actionId
            ? {
                ...a,
                steps: a.steps.map((st) =>
                  st.id === stepId ? { ...st, enabled: st.enabled === false } : st
                ),
              }
            : a
        ),
      }));
      persist(sets);
      return { sets };
    });
  },

  deleteStep(actionId: string, stepId: string): void {
    useAutoActionStore.setState((prev) => {
      const sets = prev.sets.map((s) => ({
        ...s,
        actions: s.actions.map((a) =>
          a.id === actionId
            ? { ...a, steps: a.steps.filter((st) => st.id !== stepId) }
            : a
        ),
      }));
      persist(sets);
      return { sets };
    });
  },

  replaceSets(sets: AutoActionSet[]): void {
    persist(sets);
    useAutoActionStore.setState({
      sets,
      activeSetId: sets[0]?.id ?? '',
      selectedActionId: sets[0]?.actions[0]?.id ?? null,
      isRecording: false,
      recordingActionId: null,
    });
  },

  setIsPlaying(isPlaying: boolean): void {
    useAutoActionStore.setState({ isPlaying });
  },
};
