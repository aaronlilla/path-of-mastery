import { useCallback, useEffect, useRef, useState } from 'react';
import type { Result } from './presenter.js';

export type Loaded<T> = { status: 'loading' } | { status: 'error'; code: Extract<Result<T>, { ok: false }>['code'] } | { status: 'ready'; value: T };
/** Loads once, again when `deps` change, and on `reload()`. Late answers from an older call are dropped. */
export function useLoad<T>(load: () => Promise<Result<T>>, deps: unknown[]): [Loaded<T>, () => void, (v: T) => void] {
  const [state, setState] = useState<Loaded<T>>({ status: 'loading' }), [tick, setTick] = useState(0), seq = useRef(0);
  const fn = useRef(load); fn.current = load;
  useEffect(() => {
    const mine = ++seq.current; setState((s) => (s.status === 'ready' ? s : { status: 'loading' }));
    fn.current().then((r) => { if (mine === seq.current) setState(r.ok ? { status: 'ready', value: r.value } : { status: 'error', code: r.code }); },
      () => { if (mine === seq.current) setState({ status: 'error', code: 'UNAVAILABLE' }); });
    return () => { seq.current++; };
  }, [tick, ...deps]); // eslint-disable-line react-hooks/exhaustive-deps
  const reload = useCallback(() => { setState({ status: 'loading' }); setTick((n) => n + 1); }, []);
  const set = useCallback((v: T) => setState({ status: 'ready', value: v }), []);
  return [state, reload, set];
}
