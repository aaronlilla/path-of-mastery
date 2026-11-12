import { useCallback, useEffect, useRef, useState } from 'react';
import { EMPTY_SHARED, type SharedItems } from '../../shared/sharedItems.js';
import { useToast } from '../ui';
import { tr } from '../i18n';

/** The items and item sets shared between builds: read when the tab opens, written (through main) after every change. */
export function useShared() {
  const toast = useToast();
  const [data, setData] = useState<SharedItems>(EMPTY_SHARED);
  const [ready, setReady] = useState(false);
  const latest = useRef<SharedItems>(EMPTY_SHARED);

  useEffect(() => {
    let dead = false;
    const load = () =>
      void window.pom.shared.get().then((r) => {
        if (dead) return;
        if (r.ok) {
          latest.current = r.value;
          setData(r.value);
        } else toast({ text: tr('items_useShared.couldn_t_read_the_shared', { error: r.error }), kind: 'error' });
        setReady(true);
      });
    load();
    // The assistant can add to the list; read it again so the next change here does not drop that.
    const off = window.pom.shared.onChanged?.(load);
    return () => {
      dead = true;
      off?.();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const update = useCallback(
    (fn: (list: SharedItems) => SharedItems) => {
      const next = fn(latest.current);
      latest.current = next;
      setData(next);
      void window.pom.shared.set(next).then((r) => {
        if (!r.ok) toast({ text: tr('items_useShared.couldn_t_save_the_shared', { error: r.error }), kind: 'error' });
      });
    },
    [toast],
  );

  return { data, ready, update };
}

export type SharedState = ReturnType<typeof useShared>;
