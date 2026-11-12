import { useSyncExternalStore } from 'react';
import type { StatScalar } from '@pom/protocol';

/** The stat changes a hovered tree node would make, shown beside the sidebar's rows. */
export type Deltas = Record<string, [StatScalar, StatScalar]> | null;

/**
 * Hover deltas live in this small store instead of the build workspace's state: as state, every hover re-rendered the whole
 * workspace (tree, header, open tabs) twice. Now only the sidebar, which reads them, renders again.
 */
export interface DeltaStore {
  get(): Deltas;
  set(d: Deltas): void;
  subscribe(listener: () => void): () => void;
}

export function createDeltaStore(): DeltaStore {
  let value: Deltas = null;
  const listeners = new Set<() => void>();
  return {
    get: () => value,
    set: (d) => {
      if (d === value) return;
      value = d;
      for (const l of listeners) l();
    },
    subscribe: (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
  };
}

export function useDeltas(store: DeltaStore): Deltas {
  return useSyncExternalStore(store.subscribe, store.get);
}
