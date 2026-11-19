import { useRef, useSyncExternalStore } from 'react';

export type StoreListener = () => void;
export type StateUpdater<T> = Partial<T> | ((prev: T) => Partial<T>);
export type EqualityFn<U> = (a: U, b: U) => boolean;

export interface StoreApi<T> {
  getState: () => T;
  setState: (partial: StateUpdater<T>) => void;
  subscribe: (listener: StoreListener) => () => void;
  reset: () => void;
}

export interface UseBoundStore<T> extends StoreApi<T> {
  (): T;
  <U>(selector: (state: T) => U, equalityFn?: EqualityFn<U>): U;
}

export function shallowEqual<T>(a: T, b: T): boolean {
  if (Object.is(a, b)) return true;
  if (typeof a !== 'object' || a === null || typeof b !== 'object' || b === null) {
    return false;
  }
  const keysA = Object.keys(a as Record<string, unknown>);
  const keysB = Object.keys(b as Record<string, unknown>);
  if (keysA.length !== keysB.length) return false;
  for (let i = 0; i < keysA.length; i++) {
    const key = keysA[i];
    if (
      !Object.prototype.hasOwnProperty.call(b, key) ||
      !Object.is((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key])
    ) {
      return false;
    }
  }
  return true;
}

export function createStore<T extends object>(initializer: () => T): UseBoundStore<T> {
  let state: T = initializer();
  const listeners = new Set<StoreListener>();

  const getState = (): T => state;

  const setState = (partial: StateUpdater<T>): void => {
    const patch = typeof partial === 'function' ? partial(state) : partial;
    if (!patch || Object.is(patch, state)) return;

    let changed = false;
    for (const key of Object.keys(patch) as Array<keyof T>) {
      if (!Object.is(state[key], patch[key])) {
        changed = true;
        break;
      }
    }
    if (!changed) return;

    state = { ...state, ...patch };
    listeners.forEach((listener) => listener());
  };

  const subscribe = (listener: StoreListener): (() => void) => {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  };

  const reset = (): void => {
    state = initializer();
    listeners.forEach((listener) => listener());
  };

  function useStore(): T;
  function useStore<U>(selector: (state: T) => U, equalityFn?: EqualityFn<U>): U;
  function useStore<U>(
    selector?: (state: T) => U,
    equalityFn: EqualityFn<U> = Object.is
  ): T | U {
    const selectorRef = useRef(selector);
    selectorRef.current = selector;

    const equalityRef = useRef(equalityFn);
    equalityRef.current = equalityFn;

    const snapshotRef = useRef<{ hasValue: boolean; value: T | U }>({
      hasValue: false,
      value: undefined as unknown as T,
    });

    const getSnapshot = (): T | U => {
      const currentState = getState();
      const sel = selectorRef.current;
      const next = sel ? sel(currentState) : currentState;
      if (snapshotRef.current.hasValue) {
        const prev = snapshotRef.current.value;
        if (sel) {
          if (equalityRef.current(prev as U, next as U)) {
            return prev;
          }
        } else if (Object.is(prev, next)) {
          return prev;
        }
      }
      snapshotRef.current = { hasValue: true, value: next };
      return next;
    };

    return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  }

  return Object.assign(useStore, {
    getState,
    setState,
    subscribe,
    reset,
  });
}
