import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { AccountApi, AccountView, BuildSyncStatus, SyncView } from '../../shared/accounts.js';
import { useToast } from '../ui';
import { fromMain } from '../i18n';

/** A sentence the main process wrote for the account screens (an error, a sync line, a version note), in the player's language. A " · " list is told piece by piece. */
export function acctText(s: string): string {
  const one = (x: string) => fromMain('accounts_text', x);
  const whole = one(s);
  if (whole !== s) return whole;
  if (/^(Tree|Items|Skills|Config|Notes)(, (items|skills|config|notes))*$/.test(s)) return s.split(', ').map((x) => one(x[0]!.toUpperCase() + x.slice(1))).join(', ');
  return s.split(' · ').map(one).join(' · ');
}
/** The account calls with a failure's message in the player's language. */
function translated(api: AccountApi): AccountApi {
  // The target is empty: the preload's frozen object would make the proxy refuse to return a wrapped function.
  return new Proxy({} as AccountApi, {
    get(_, k) {
      const t = api;
      const v = (t as unknown as Record<string | symbol, unknown>)[k];
      if (typeof v !== 'function') return v;
      return (...a: unknown[]) => {
        const r = (v as (...x: unknown[]) => unknown).apply(t, a);
        return r instanceof Promise ? r.then((x: unknown) => (x && typeof x === 'object' && (x as { ok?: unknown }).ok === false && typeof (x as { error?: unknown }).error === 'string' ? { ...x, error: acctText((x as { error: string }).error) } : x)) : r;
      };
    },
  });
}

export interface AccountCtxValue {
  view: AccountView | null;
  signedIn: boolean;
  /** The sync's numbers when signed in. */
  sync: SyncView | null;
  /** Where one build stands in the sync, or undefined for a build that is local only. */
  statusOf(localId: string): BuildSyncStatus | undefined;
  api: AccountApi;
  /** Opens the sign-in dialog. */
  openSignIn(): void;
}

const noop = () => undefined;
const AccountCtx = createContext<AccountCtxValue | null>(null);

export function AccountProvider({ children, openSignIn }: { children: ReactNode; openSignIn: () => void }) {
  const toast = useToast();
  const [view, setView] = useState<AccountView | null>(null);
  const lastError = useRef<string | undefined>(undefined);
  useEffect(() => {
    let alive = true;
    void window.pom.account.view().then((r) => alive && r.ok && setView(r.value));
    const off = window.pom.account.onChanged((v) => setView(v));
    return () => {
      alive = false;
      off();
    };
  }, []);
  // A sign-in problem that happens with the dialog closed (a link that expired) still reaches the player.
  useEffect(() => {
    const err = view?.error;
    if (err && err !== lastError.current) toast({ text: acctText(err), kind: 'error' });
    lastError.current = err;
  }, [view?.error, toast]);

  const value = useMemo<AccountCtxValue>(() => {
    const signedIn = view?.auth.state === 'signedIn' || view?.auth.state === 'restoring';
    const sync = signedIn ? view?.sync ?? null : null;
    return { view, signedIn, sync, statusOf: (id) => sync?.builds[id], api: translated(window.pom.account), openSignIn };
  }, [view, openSignIn]);
  return <AccountCtx.Provider value={value}>{children}</AccountCtx.Provider>;
}

export function useAcct(): AccountCtxValue {
  const v = useContext(AccountCtx);
  if (!v) throw new Error('useAcct needs an AccountProvider');
  return v;
}

/** True when a player is signed in; false when signed out or when there is no account provider (a screen used on its own). */
export function useSignedIn(): boolean {
  return useContext(AccountCtx)?.signedIn ?? false;
}

/** Calls an account method and turns a failure into a toast. Resolves to the value, or undefined on failure. */
export function useAcctCall() {
  const toast = useToast();
  return useCallback(
    async <T,>(p: Promise<{ ok: true; value: T } | { ok: false; error: string }>): Promise<T | undefined> => {
      const r = await p;
      if (!r.ok) {
        toast({ text: r.error, kind: 'error' });
        return undefined;
      }
      return r.value;
    },
    [toast],
  );
}

void noop;
