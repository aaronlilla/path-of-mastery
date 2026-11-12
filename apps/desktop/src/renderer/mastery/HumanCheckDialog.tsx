// Mounts the human-check dialog for the Marketplace. The challenge, verification and admission all run in the main process
// (main/mastery/admission.ts, channel mastery:network); this only shows the provider page and relays its answer token.
import { useCallback, useEffect, useRef, useState } from 'react';
import { NetworkCheck, NetworkCheckBanner, type CheckState } from '../gates/network/NetworkCheck.js';
import { call, on } from './bridge.js';
import { humanCheck } from './humanCheck.js';
import { tr } from '../i18n';

type Stage = { status: 'none' | 'unavailable' | 'expired' | 'again' } | { status: 'sendFailed'; code: string } | { status: 'passed'; resumed?: { operation: string; body: unknown; entry: unknown } } | { status: 'ready'; accessibleAvailable: boolean; presentationUrl: string; accessibleUrl: string | null; pending?: string };
const CHANNEL = 'mastery:network';
const ask = (method: string, extra: Record<string, unknown> = {}) => call<Stage>(CHANNEL, { schemaVersion: 1, method, ...extra });
/** The provider page posts `{ type: 'pom-network-token', token }` to this window when the person finishes the check. */
export const TOKEN_MESSAGE = 'pom-network-token';
/** Window event fired after Continue resent a paused request: detail { operation, body, entry } (the outbox entry with its answer). */
export const RESUMED_EVENT = 'pom-network-resumed';

export function HumanCheckHost({ online }: { online: boolean }) {
  const [open, setOpen] = useState(false);
  // Banner: a Marketplace request the site paused for a check (null when nothing is paused).
  const [paused, setPaused] = useState<string | null>(null);
  // Where the keyboard focus goes back to when the check closes: the control that opened it, or, when the
  // check was opened by the app itself (an AI request answered by the site) while nothing was focused, the current area's tab.
  const opener = useRef<HTMLElement | null>(null);
  useEffect(() => humanCheck.subscribe(next => {
    if (next) { const a = document.activeElement; opener.current = a instanceof HTMLElement && a !== document.body ? a : null; }
    setOpen(next);
    // Main watches Escape for the open check (keys inside the provider's frame never reach this page).
    void ask('dialog', { open: next }).catch(() => undefined);
    if (!next) setTimeout(() => {
      const a = document.activeElement; if (a && a !== document.body) return;
      const back = opener.current?.isConnected ? opener.current : document.querySelector<HTMLElement>('.area-switch [aria-current="page"]');
      back?.focus();
    }, 0);
  }), []);
  // The main process asks for a check when the site refused an AI request. Declining leaves that request denied.
  useEffect(() => on('mastery:push:human-check', () => {
    void humanCheck.run({ ai: true }).then(passed => { if (!passed) void ask('cancel').catch(() => undefined); else setPaused(null); });
  }), []);
  // A (re)loaded window: a request still waiting for a check is asked again here (main/mastery/admission.ts hello), and a paused
  // Marketplace request gets its banner back.
  useEffect(() => { void ask('hello').then(r => { const p = (r as unknown as { paused?: unknown }).paused; if (typeof p === 'string' && p) setPaused(p); }, () => undefined); }, []);
  // Escape pressed anywhere in the window while the check is open, the provider's frame included: close it as its X does.
  useEffect(() => on('mastery:push:human-check-escape', () => { humanCheck.finish(false); }), []);
  useEffect(() => on('mastery:push:network-paused', payload => {
    const pending = (payload as { pending?: unknown } | null)?.pending;
    setPaused(typeof pending === 'string' && pending ? pending : tr('mastery_HumanCheckDialog.marketplace_request'));
  }), []);
  return <>
    {paused && <NetworkCheckBanner onOpen={() => { void humanCheck.run().then(passed => { if (passed) setPaused(null); }); }} onLocal={() => undefined} />}
    {open && <HumanCheckDialog online={online} />}
  </>;
}

function HumanCheckDialog({ online }: { online: boolean }) {
  const [state, setState] = useState<CheckState>(online ? 'checking' : 'offline');
  const [stage, setStage] = useState<Extract<Stage, { status: 'ready' }> | null>(null);
  const [accessible, setAccessible] = useState(false);
  // The specific paused action ("Pending: {specific action}"); kept after the provider stage clears.
  const [pending, setPending] = useState<string | undefined>(undefined);
  const live = useRef(true);
  useEffect(() => () => { live.current = false; }, []);
  // The main process says the paused request's wait ran out before the check passed.
  useEffect(() => on('mastery:push:human-check-expired', () => { if (live.current) setState('expired'); }), []);

  const begin = useCallback(async (wantAccessible: boolean, again = false) => {
    if (!online) { setState('offline'); return; }
    setState(again ? 'again' : 'checking'); setStage(null);
    try {
      const next = await ask('begin', { accessible: wantAccessible });
      if (!live.current) return;
      if (next.status === 'ready') { setStage(next); setAccessible(wantAccessible); if (next.pending) setPending(next.pending); } else setState('unavailable');
    } catch { if (live.current) setState('unavailable'); }
  }, [online]);
  useEffect(() => { void begin(false); }, [begin]);

  const url = stage ? (accessible && stage.accessibleUrl ? stage.accessibleUrl : stage.presentationUrl) : null;
  useEffect(() => {
    if (!url) return;
    const origin = new URL(url).origin;
    const onMessage = (event: MessageEvent) => {
      const data = event.data as { type?: unknown; token?: unknown } | null;
      if (event.origin !== origin || data?.type !== TOKEN_MESSAGE || typeof data.token !== 'string') return;
      void ask('complete', { token: data.token }).then(
        r => { if (live.current) setState(r.status === 'passed' ? 'passed' : r.status === 'expired' ? 'expired' : 'failed'); },
        () => { if (live.current) setState('failed'); });
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [url]);

  return <NetworkCheck state={state} accessibleAvailable={!!stage?.accessibleUrl && !accessible} accessibleActive={accessible && !!stage} pendingLabel={pending}
    verification={url ? <iframe title={tr('mastery_HumanCheckDialog.human_check')} src={url} sandbox="allow-scripts allow-forms allow-same-origin" referrerPolicy="no-referrer"
      style={{ width: '100%', height: 220, border: 0 }} /> : null}
    onAccessible={() => void begin(true)} onRetry={() => void begin(accessible)}
    // Continue retries the paused request once (AI request, vote or save); publish/report/feedback go back to their own review.
    onContinue={async () => {
      const r = await ask('resume'); if (r.status === 'unavailable') throw new Error('not resumable');
      // Nothing left to send (the wait ran out): say so and offer Retry, never close as if it had worked.
      if (r.status === 'expired' || r.status === 'none') { if (live.current) setState('expired'); return; }
      // The check no longer counted when the request went out: same request, fresh check, then Continue sends it once.
      if (r.status === 'again') { if (live.current) void begin(accessible, true); return; }
      // The request went out and the site said no for another reason: say so plainly; Keep working locally closes.
      if (r.status === 'sendFailed') { if (live.current) setState('sendFailed'); return; }
      // The resumed vote/save's answer, so the Marketplace card shows the counted vote instead of the earlier refusal.
      if (r.status === 'passed' && r.resumed) window.dispatchEvent(new CustomEvent(RESUMED_EVENT, { detail: r.resumed }));
      humanCheck.finish(true);
    }}
    onLocal={() => humanCheck.finish(false)} />;
}
