// A minimal observable store (no external dep). The SPA's session and
// workspace-switch state use it; a preact hook (useStore) re-renders on change.
import { useEffect, useState } from 'preact/hooks';

export interface Store<T> {
  get(): T;
  set(next: T | ((prev: T) => T)): void;
  subscribe(fn: (value: T) => void): () => void;
}

/** Create an observable store with an initial value. */
export function createStore<T>(initial: T): Store<T> {
  let value = initial;
  const subs = new Set<(v: T) => void>();
  return {
    get: () => value,
    set: (next) => {
      value = typeof next === 'function' ? (next as (p: T) => T)(value) : next;
      for (const fn of subs) fn(value);
    },
    subscribe: (fn) => {
      subs.add(fn);
      return () => subs.delete(fn);
    },
  };
}

/** Preact hook: subscribe to a store and re-render on change. */
export function useStore<T>(store: Store<T>): T {
  const [, force] = useState(0);
  useEffect(() => store.subscribe(() => force((n) => n + 1)), [store]);
  return store.get();
}
