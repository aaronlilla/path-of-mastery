import { useCallback, useEffect, useRef, useState, type CSSProperties } from 'react';
import type { RunBridge, RunReply } from '../../shared/run/bridge.js';
import type { RunCommand, RunView } from '../../shared/run/types.js';
import type { WindowPreferences } from '../../shared/run/window.js';
import { DetailsPanel, LogPanel, MenuPanel, PositionPanel, SettingsPanel } from './Panels';
import { Strip } from './Strip';
import { WindowFit } from './fit';
import { CompletionPanel, FeedbackPanel } from './Completion';
import { clampOpacity, newId, resolveLayout, stripModel, textSizes, type RunMeta } from './presenter';
import type { RunServices } from './services';
import type { RunInfo } from '../../shared/run/services.js';
import { bridgeServices, metaFrom, playTone } from './bridgeServices';

export type PanelName = 'menu' | 'details' | 'position' | 'log' | 'settings' | 'complete' | 'feedback';
export type RunCtx = {
  bridge: RunBridge; view: RunView; meta: RunMeta; services: RunServices; prefs: WindowPreferences;
  send(command: RunCommand extends infer C ? C extends { commandId: string } ? Omit<C, 'commandId'> : never : never): Promise<RunView | null>;
  open(panel: PanelName | null, extra?: { actionId?: string; tab?: 'current' | 'missed' | 'source' }): void;
  error: string | null;
};
export const DEFAULT_PREFS: WindowPreferences = { bounds: { x: 0, y: 0, width: 960, height: 144 }, monitorId: '', alwaysOnTop: true, size: 'standard',
  orientation: 'auto', textSize: 26, opacity: 0.95, sound: false };
const ERROR_COPY: Record<string, string> = { SAVE_FAILED: 'Progress could not be saved. Retry or export a recovery file.', UNAVAILABLE: 'Run is not available right now.',
  INVALID: 'That did not go through.', FORBIDDEN: 'That did not go through.', RUN_REQUEST_FAILED: 'That did not go through.' };

const MAX_PANEL_HEIGHT = 640;
export function RunApp({ bridge, meta: givenMeta, services: givenServices }: { bridge: RunBridge; meta?: RunMeta; services?: RunServices }) {
  const [info, setInfo] = useState<RunInfo | null>(null);
  const meta = metaFrom(info, givenMeta), services = givenServices ?? bridgeServices(bridge, info);
  const [view, setView] = useState<RunView | null | undefined>(undefined);
  const [prefs, setPrefs] = useState<WindowPreferences>(DEFAULT_PREFS);
  const [prefsReady, setPrefsReady] = useState(false); // true once the main process has told us the real window settings
  const [panel, setPanel] = useState<PanelName | null>(null);
  const [extra, setExtra] = useState<{ actionId?: string; tab?: 'current' | 'missed' | 'source' }>({});
  const [error, setError] = useState<string | null>(null);
  const [rehomed, setRehomed] = useState(false);
  const [size, setSize] = useState({ w: typeof innerWidth === 'number' ? innerWidth : 960, h: typeof innerHeight === 'number' ? innerHeight : 144 });
  const completionShown = useRef<string | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);

  const apply = useCallback(<T,>(reply: RunReply<T>, take: (value: T) => void): boolean => {
    if (reply.ok) { setError(null); take(reply.value); return true; }
    setError(ERROR_COPY[reply.code] ?? ERROR_COPY.INVALID!); return false;
  }, []);
  useEffect(() => {
    let live = true;
    void bridge.view().then(r => { if (live) apply(r, v => setView(v)); });
    void bridge.services({ kind: 'info' }).then(r => { if (live && r.ok) setInfo(r.value as RunInfo); }, () => undefined);
    void bridge.windowSettings().then(r => { if (live) apply(r, p => { if (p) { setPrefs(p); setPrefsReady(true); } }); });
    const off = bridge.subscribe(message => {
      if (message && 'kind' in message) { setPrefs(message.preferences); setPrefsReady(true); setRehomed(message.rehomed); } else setView(message);
    });
    return () => { live = false; off(); };
  }, [bridge, apply]);
  useEffect(() => { // lay out against the Run window itself, not the browser viewport
    const el = rootRef.current; if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(([entry]) => { if (entry) setSize({ w: entry.contentRect.width, h: entry.contentRect.height }); });
    ro.observe(el); return () => ro.disconnect();
  }, [view === undefined, view === null]); // eslint-disable-line react-hooks/exhaustive-deps

  // Long instructions wrap and are never cut: when the text needs more room than the strip has, the window grows to fit,
  // and goes back to its reference height once the text is short again. Driven by the content's actual size (ResizeObserver on the
  // content, MutationObserver for panel changes, font load), never by timers; the request is re-sent until the main process acknowledges.
  const [, setTick] = useState(0);
  const fit = useRef(new WindowFit());
  const remeasure = useCallback(() => setTick(t => t + 1), []);
  const acked = useRef<number | null>(null); // height main confirmed, used until the page itself reports its new size
  const retry = useRef<ReturnType<typeof setTimeout>>();
  const retryLater = useCallback((ms: number) => { clearTimeout(retry.current); retry.current = setTimeout(remeasure, ms); }, [remeasure]);
  useEffect(() => {
    const root = rootRef.current; if (!root || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => { acked.current = null; fit.current.contentChanged(); remeasure(); });
    const watch = () => { // everything whose size decides the needed height: the strip's rows, the open panel's body
      ro.disconnect(); ro.observe(root);
      root.querySelectorAll('.run-surface, .run-surface > *, .run-overlay .run-frame, .run-overlay .run-body').forEach(el => ro.observe(el));
    };
    watch();
    const mo = typeof MutationObserver === 'undefined' ? null : new MutationObserver(() => { watch(); fit.current.contentChanged(); remeasure(); });
    mo?.observe(root, { childList: true, subtree: true, characterData: true });
    void document.fonts?.ready.then(() => { fit.current.contentChanged(); remeasure(); }); // fonts change text metrics after first paint
    const onFocus = () => { acked.current = null; fit.current.contentChanged(); remeasure(); }; // a window that was hidden or stuck is asked again when it is focused
    addEventListener('focus', onFocus);
    return () => { ro.disconnect(); mo?.disconnect(); removeEventListener('focus', onFocus); clearTimeout(retry.current); };
  }, [view === undefined, view === null, remeasure]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    const root = rootRef.current, surface = root?.querySelector<HTMLElement>('.run-surface');
    if (!root || !surface || !view) return;
    const strip = surface.parentElement!;
    const fixed = [...strip.children].filter(c => c !== surface).reduce((n, c) => n + (c as HTMLElement).offsetHeight, 0);
    const cs = getComputedStyle(surface);
    const body = [...surface.children].reduce((n, c) => n + (c as HTMLElement).offsetHeight, 0) + parseFloat(cs.rowGap || '0') * Math.max(0, surface.children.length - 1)
      + parseFloat(cs.paddingTop) + parseFloat(cs.paddingBottom);
    let needed = Math.ceil(fixed + body + 2);
    // An open panel (Details, Auto-follow, Settings...) must show its content too, up to a screen-friendly cap; past that its body scrolls.
    const frame = root.querySelector<HTMLElement>('.run-overlay .run-frame'), pbody = frame?.querySelector<HTMLElement>('.run-body');
    if (frame && pbody) {
      const chrome = [...frame.children].filter(c => c !== pbody).reduce((n, c) => n + (c as HTMLElement).offsetHeight, 0);
      needed = Math.max(needed, Math.min(root.dataset.layout === 'vertical' ? 600 : MAX_PANEL_HEIGHT, Math.ceil(chrome + pbody.scrollHeight + 2)));
    }
    // The window's real height (what the user sees) is the truth, not a copy of the settings that may be older.
    const current = acked.current ?? (typeof innerHeight === 'number' && innerHeight > 0 ? Math.round(innerHeight) : prefs.bounds.height);
    const target = fit.current.plan({ needed, current, ready: prefsReady });
    if (target === null) return;
    const next = { ...prefs, bounds: { ...prefs.bounds, height: target } };
    void bridge.saveWindowSettings(next).then(r => {
      if (r.ok && r.value) { acked.current = r.value.bounds.height; fit.current.acked(r.value.bounds.height); setPrefs(r.value); }
      else retryLater(fit.current.failed()); // lost or refused: ask again, 50 ms doubling to 5 s, until acknowledged
    }, () => retryLater(fit.current.failed()));
  });

  // "Sound on next step": one short tone when the guide moves forward to a later chunk (not on Back, not on the first view).
  const chunkIndex = view ? view.snapshot.bundles.findIndex(b => b.bundleId === view.displayed.bundleId) : -1;
  const lastChunk = useRef<number | null>(null);
  useEffect(() => {
    if (chunkIndex < 0) return;
    if (lastChunk.current !== null && chunkIndex > lastChunk.current && prefs.sound) playTone();
    lastChunk.current = chunkIndex;
  }, [chunkIndex, prefs.sound]);

  // Completion opens by itself once, right after the final bundle is acknowledged.
  const ended = view?.state.endedAt ?? null, runId = view?.snapshot.runId ?? null;
  useEffect(() => {
    if (ended && runId && completionShown.current !== runId) { completionShown.current = runId; setPanel('complete'); }
  }, [ended, runId]);

  const send: RunCtx['send'] = useCallback(async command => {
    const r = await bridge.command({ ...command, commandId: newId('c') } as RunCommand);
    let next: RunView | null = null;
    apply(r, v => { next = v; setView(v); });
    return next;
  }, [bridge, apply]);
  const open: RunCtx['open'] = useCallback((name, more = {}) => { setPanel(name); setExtra(more); }, []);

  // Closing the details panel returns to the same position; the service reconciles through the catch-up rule.
  const closePanel = useCallback(() => {
    if (panel === 'details') void send({ kind: 'closeDetails' });
    setPanel(null);
  }, [panel, send]);

  if (view === undefined) return <div className="run-root" data-state="loading"><div className="run-wait">Loading Run...</div></div>;
  if (view === null) return <div className="run-root" data-state="empty"><div className="run-wait">No Run is active. Start one from a Timeline.</div></div>;

  const layout = resolveLayout(prefs.orientation, size.w, size.h);
  const sizes = textSizes(prefs);
  const ctx: RunCtx = { bridge, view, meta, services, prefs, send, open, error };
  const style = { '--run-main': `${sizes.main}px`, '--run-support': `${sizes.support}px`, '--run-bg-alpha': clampOpacity(prefs.opacity) } as CSSProperties;
  return <div className="run-root" ref={rootRef} data-layout={layout} data-panel={panel ?? ''} style={style}>
    <Strip ctx={ctx} panelOpen={panel !== null} onClose={closePanel} rehomed={rehomed} onReply={r => apply(r, v => setView(v))} />
    {panel && <div className="run-overlay" data-popup role="dialog" aria-modal="true" aria-label={panel}>
      {panel === 'menu' && <MenuPanel ctx={ctx} onClose={closePanel} />}
      {panel === 'details' && <DetailsPanel ctx={ctx} onClose={closePanel} initialTab={extra.tab} />}
      {panel === 'position' && <PositionPanel ctx={ctx} onClose={closePanel} />}
      {panel === 'log' && <LogPanel ctx={ctx} onClose={closePanel} />}
      {panel === 'settings' && <SettingsPanel ctx={ctx} onClose={closePanel} setPrefs={setPrefs} />}
      {panel === 'complete' && <CompletionPanel ctx={ctx} onClose={closePanel} />}
      {panel === 'feedback' && <FeedbackPanel ctx={ctx} onClose={closePanel} actionId={extra.actionId} />}
    </div>}
  </div>;
}
