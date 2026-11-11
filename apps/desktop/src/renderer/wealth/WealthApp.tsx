import { useEffect, useRef, useState } from 'react';
import { fmtChaos, fmtDuration, type InboxEntry, type WealthView } from '../../shared/wealth.js';
import { fmtAgo, fmtOld, msg } from './mainText';
import { boardOpen } from '../../shared/bulk.js';
import { Dialog, Icon, useDismiss, useToast } from '../ui.js';
import { ArchivePanel } from '../documents/ArchivePanel';
import { Board } from './Board.js';
import { CONNECTION_EVENT, ConnectionCheck } from './ConnectionCheck.js';
import { FirstLoad } from './FirstLoad.js';
import { loadSteps } from './loadSteps.js';
import { UpgradeWatch } from './UpgradeWatch.js';
import type { LibraryChoice, PremiumBuild } from './premiumUi.js';
import type { BuildEdit } from '@pom/protocol';
import type { TryResult } from './stashItem.js';
import { FirstVisit } from './FirstVisit.js';
import { useDelayedFlag } from '../delayedFlag.js';
import { Filter } from './Filter.js';
import { Market } from './Market.js';
import { Overview } from './Overview.js';
import { Sessions } from './Sessions.js';
import { Stash } from './Stash.js';
import { Strategies } from './Strategies.js';
import { ago, Modal, Panel } from './wui.js';
import type { Sub, Wealth, WealthUi } from './useWealth.js';
import './wealth.css';
import './premium.css';
import { tr } from '../i18n';

/** The nav entries of the design, in its order. Your filter is reached from Overview, never a nav entry; the Bulk board joins the nav once enough sellers use it (the spec). */
const NAV: { id: Sub; label: string; icon: string; premium?: boolean }[] = [
  { id: 'overview', label: tr('wealth_WealthApp.overview'), icon: 'layout' },
  { id: 'stash', label: tr('wealth_WealthApp.stash'), icon: 'stash' },
  { id: 'sessions', label: tr('wealth_WealthApp.sessions'), icon: 'timer' },
  { id: 'strategies', label: tr('wealth_WealthApp.strategies'), icon: 'map' },
  { id: 'market', label: tr('wealth_WealthApp.market'), icon: 'market' },
  { id: 'board', label: tr('wealth_WealthApp.bulk_board'), icon: 'tag' },
  // Upgrade watch runs on code, not AI: free for everyone, so it carries no premium marker.
  { id: 'watch', label: tr('wealth_WealthApp.upgrade_watch'), icon: 'eye' },
];

/** Screens reached from inside another screen: which nav entry they belong under, and what they are called. */
const TRAIL: Partial<Record<Sub, { under: Sub; label: string; back: string }>> = {
  board: { under: 'stash', label: tr('wealth_WealthApp.bulk_board'), back: tr('wealth_WealthApp_2.stash') },
  filter: { under: 'overview', label: tr('wealth_WealthApp.your_filter'), back: tr('wealth_WealthApp_2.overview') },
};

export interface WealthPremiumProps {
  build: PremiumBuild | null;
  library: LibraryChoice[];
  onPickBuild: (id: string) => void;
  /** Name of the build open in Builds, when there is one, so the watch list can offer to go back to it. */
  openName?: string;
  onEquip?: (edit: BuildEdit) => Promise<boolean>;
  /** Calculates an item in its slot of the open build without changing it (the engine's previewEdit). */
  onTryItem?: (itemText: string) => Promise<TryResult | { error: string }>;
}

/** What the sync dot says, in words with real numbers (it is the tooltip and the accessible name). */
export function syncLabel(w: WealthView, now: number): string {
  const y = w.sync;
  const mins = y.lastSyncAt ? Math.max(0, Math.round((now - y.lastSyncAt) / 60000)) : null;
  const rd = y.reading;
  return y.phase === 'reading'
    ? rd ? tr('wealth_WealthApp.reading_your_stash_tab_total', { total: Math.min(rd.done + 1, rd.total), total2: rd.total }) : tr('wealth_WealthApp.reading_your_stash')
    : !y.lastSyncAt && w.prices.lines === 0 && !w.prices.failed
      ? w.prices.progress ? tr('wealth_WealthApp.loading_prices_done_of_total', { done: w.prices.progress.done, total: w.prices.progress.total }) : tr('wealth_WealthApp.loading_prices')
      : y.phase === 'rate-limited'
        ? tr('wealth_WealthApp.waiting_for_ggg_resumes_in', { now: Math.max(1, Math.round(((y.resumesAt ?? now) - now) / 1000)) })
        : y.phase === 'expired'
          ? tr('wealth_WealthApp.reconnect_to_keep_syncing')
          : y.phase === 'down'
            ? tr('wealth_WealthApp.ggg_not_responding')
            : mins === null ? tr('wealth_WealthApp.not_read_yet') : tr('wealth_WealthApp.auto_sync_lastsyncat', { lastSyncAt: fmtAgo(now - y.lastSyncAt!) });
}

export function WealthApp({ s, p }: { s: Wealth; p: WealthPremiumProps }) {
  const { w, ui, go, now } = s;
  const toast = useToast();
  /** Latched on the first render with data: the first-visit flow stays up until it says it is done, even though connecting flips `connected` on half way through. */
  const [firstVisit, setFirstVisit] = useState<boolean | null>(null);
  const [reconnect, setReconnect] = useState(false);
  const [conn, setConn] = useState(false);
  useEffect(() => {
    const open = () => setConn(true);
    window.addEventListener(CONNECTION_EVENT, open);
    return () => window.removeEventListener(CONNECTION_EVENT, open);
  }, []);
  useEffect(() => {
    if (w && firstVisit === null) setFirstVisit(!w.sync.connected);
  }, [w, firstVisit]);
  /** The placeholder shows only when the first read is slow, and then long enough to read; a read that lands within a few frames never blips it. */
  const loading = useDelayedFlag(!w, 200);
  if (!w || loading) return <div className="w-app">{loading && <div className="w-loading">{tr('wealth_WealthApp.loading_wealth')}</div>}</div>;
  const connected = w.sync.connected;
  // Not gated on the latch effect: before it runs, firstVisit is null and !connected gives the same answer, so the first render with data is the real screen.
  const showFirst = firstVisit || !connected;
  /** Market and Strategies read public prices, so they open before a Path of Exile account is connected; the rest need the stash. */
  const gate = showFirst && ui.sub !== 'market' && ui.sub !== 'strategies';
  const expired = connected && w.sync.phase === 'expired';
  const prices = w.prices;
  const noStash = w.rows.length === 0 && !w.sync.lastSyncAt;
  const pricesLoading = prices.lines === 0 && !prices.failed;
  const stashLoading = connected && noStash && w.sync.phase !== 'expired' && w.sync.phase !== 'down';
  /** The price fetch finished and there are no prices: say so, with Retry, instead of a screen of zeros or a spinner. */
  const noPrices = prices.lines === 0 && prices.failed && !prices.loading;
  const needsPrices = (x: Sub) => noPrices && (x === 'market' || x === 'strategies' || x === 'filter');
  const firstLoad = (x: Sub): boolean => (['overview', 'stash', 'sessions', 'filter'].includes(x) && stashLoading) || (['strategies', 'market', 'filter'].includes(x) && pricesLoading);

  return (
    <div className="w-app" data-screen-label="Wealth app">
      <WealthBar s={s} showFirst={showFirst} onPickBuild={p.onPickBuild} />
      {connected && !showFirst && <Banners s={s} expired={expired} showPriceNote={!needsPrices(ui.sub)} loadingNote={(ui.sub === 'watch' || ui.sub === 'filter') && (pricesLoading || stashLoading) ? `${loadSteps(w).prices}. ${loadSteps(w).stash}.` : ''} onConn={() => setConn(true)} onReconnect={() => setReconnect(true)} />}
      {conn && <ConnectionCheck onClose={() => setConn(false)} />}
      {reconnect && (
        <Modal label={tr('wealth_WealthApp.reconnect')} onClose={() => setReconnect(false)} className="w-dlg-fv">
          <FirstVisit w={w} reconnect onDone={() => setReconnect(false)} onClose={() => setReconnect(false)} />
        </Modal>
      )}
      <div className="w-content" data-sub={ui.sub} data-trail={trailOf(s) ? '1' : undefined}>
        {!gate && trailOf(s) && (
          <div className="w-crumb" role="navigation" aria-label={tr('wealth_WealthApp.where_you_are')}>
            <button type="button" onClick={() => go(trailOf(s)!.under)}>
              <Icon name="chevron-left" size={14} />
              {trailOf(s)!.back}
            </button>
            <span aria-hidden="true">/</span>
            <b aria-current="page">{trailOf(s)!.label}</b>
          </div>
        )}
        {gate && <FirstVisit w={w} onDone={() => { setFirstVisit(false); go('overview'); toast({ text: tr('wealth_WealthApp.first_snapshot_saved_net_worth'), kind: 'ok' }); }} />}
        {!gate && firstLoad(ui.sub) && <FirstLoad w={w} sub={ui.sub} />}
        {!gate && !firstLoad(ui.sub) && needsPrices(ui.sub) && <NoPrices w={w} />}
        {!gate && !firstLoad(ui.sub) && ui.sub === 'overview' && <Overview s={s} build={p.build} onUpgrade={() => go('watch')} />}
        {!gate && !firstLoad(ui.sub) && ui.sub === 'stash' && <Stash s={s} build={p.build} {...(p.onEquip ? { onEquip: p.onEquip } : {})} {...(p.onTryItem ? { onTryItem: p.onTryItem } : {})} />}
        {!gate && !firstLoad(ui.sub) && ui.sub === 'sessions' && <Sessions s={s} />}
        {!gate && !firstLoad(ui.sub) && !needsPrices(ui.sub) && ui.sub === 'strategies' && <Strategies s={s} />}
        {!gate && !firstLoad(ui.sub) && !needsPrices(ui.sub) && ui.sub === 'market' && <Market s={s} />}
        {!gate && ui.sub === 'board' && <Board view={s.board} now={now} reload={s.reloadBoard} onStash={() => go('stash')} />}
        {!gate && !firstLoad(ui.sub) && !needsPrices(ui.sub) && ui.sub === 'filter' && <Filter s={s} />}
        {!gate && ui.sub === 'watch' && <UpgradeWatch s={s} build={p.build} library={p.library} onPick={p.onPickBuild} {...(p.openName ? { openName: p.openName } : {})} {...(p.onEquip ? { onEquip: p.onEquip } : {})} onReconnect={() => setReconnect(true)} />}
      </div>
    </div>
  );
}

/** Market, Strategies and Your filter need prices: when poe.ninja gave none, this stands in for them. */
function NoPrices({ w }: { w: WealthView }) {
  const [busy, setBusy] = useState(false);
  return (
    <div className="w-center" data-state="no-prices">
      <Panel className="w-card">
        <div className="w-later">
          <Icon name="warning" size={28} />
          <b>{tr('wealth_WealthApp.no_prices_to_show')}</b>
          <span>{msg(w.prices.message)}</span>
          <button type="button" className="w-btn" disabled={busy} onClick={() => { setBusy(true); void window.pom.wealth.retryPrices().finally(() => setBusy(false)); }}>
            <Icon name={busy ? 'loader' : 'refresh'} size={14} spin={busy} />
            {busy ? tr('wealth_WealthApp.asking_poe_ninja') : tr('wealth_WealthApp.retry')}
          </button>
        </div>
      </Panel>
    </div>
  );
}

/** The bar under the title bar: the six screens on the left; stash search, session chip, net worth, bell and sync dot on the right. */
/** Whether the Bulk board is a nav entry: enough sellers use it. */
const inNav = (s: Wealth): boolean => !!s.board && s.board.status === 'ready' && boardOpen(s.board.listings, s.now);
/** The way back from a screen reached from another one. The Bulk board has none once it is in the nav. */
const trailOf = (s: Wealth) => (s.ui.sub === 'board' && inNav(s) ? undefined : TRAIL[s.ui.sub]);

function WealthBar({ s, showFirst, onPickBuild }: { s: Wealth; showFirst: boolean; onPickBuild: (id: string) => void }) {
  const { w, ui, go, patch, now } = s;
  if (!w) return null;
  const v = w;
  const run = v.running;
  const noPrices = v.prices.lines === 0;
  const delta = noPrices ? 0 : run ? run.net : v.series.length > 1 ? v.networth - (v.series.find((x) => x.t >= now - 24 * 3600_000)?.nw ?? v.series[0]!.nw) : 0;
  const hasNumber = v.rows.length > 0 || v.networth > 0;
  const label = syncLabel(v, now);
  const y = v.sync;
  const dot = y.phase === 'idle' ? 'var(--positive)' : y.phase === 'reading' ? 'var(--gold-400)' : y.phase === 'expired' ? 'var(--negative)' : 'var(--warning)';
  const price = v.prices.fetchedAt ? tr('wealth_WealthApp_2.poe_ninja_prices', { fetchedAt: fmtOld(now - v.prices.fetchedAt) }) : tr('wealth_WealthApp_2.prices_not_loaded');
  return (
    <div className="w-bar" data-r="w-bar">
      <nav role="tablist" aria-label={tr('wealth_WealthApp.wealth')} className="w-nav" data-r="w-nav">
        {NAV.filter((n) => n.id !== 'board' || inNav(s)).map((n) => (
          <button key={n.id} type="button" role="tab" aria-selected={ui.sub === n.id || trailOf(s)?.under === n.id} aria-current={ui.sub === n.id ? 'page' : undefined} className="w-navb" onClick={() => go(n.id)}>
            <Icon name={n.icon} size={14} style={{ opacity: 0.9 }} />
            <span data-r="w-navlbl">{n.label}</span>
          </button>
        ))}
      </nav>
      <span className="w-right" data-r="w-right">
        <WealthArchive v={v} />
        <StashSearch q={ui.q} onChange={(q) => patch({ q, tab: 'all' })} onEnter={() => go('stash')} />
        {run && !showFirst && (
          <span className="w-chip-sess">
            <i />
            <button type="button" data-r="w-sess" onClick={() => go('sessions', { sess: run.id })} title={tr('wealth_WealthApp.open_in_sessions')}>{tr('wealth_WealthApp.session_minutes_m_tofixed_div', { minutes: Math.round(run.minutes), value: (run.perHour / v.divine).toFixed(1) })}</button>
            <button type="button" className="end" onClick={() => void window.pom.wealth.endSession()} aria-label={tr('wealth_WealthApp.end_session')} title={tr('wealth_WealthApp.end_session')}>
              <Icon name="stop" size={10} />
              {tr('wealth_WealthApp.end')}
            </button>
          </span>
        )}
        {hasNumber && (
          <button type="button" className="w-nwchip" onClick={() => go('overview')} title={noPrices ? tr('wealth_WealthApp.no_prices_are_loaded_so') : tr('wealth_WealthApp.net_worth_low_end_of')}>
            <b>{noPrices ? tr('wealth_WealthApp.no_prices') : tr('wealth_WealthApp.tofixed_div', { value: (v.networth / v.divine).toFixed(1) })}</b>
            {delta !== 0 && <span style={{ color: delta > 0 ? 'var(--positive-text)' : 'var(--negative-text)' }}>{delta > 0 ? '▲' : '▼'} {fmtChaos(Math.abs(delta), v.divine)}</span>}
          </button>
        )}
        <Bell s={s} onPickBuild={onPickBuild} />
        {y.connected && !showFirst && <DisconnectChip account={y.account} />}
        <button type="button" className="w-sync" onClick={() => void window.pom.wealth.syncNow()} title={tr('wealth_WealthApp.label_price_click_to_sync', { label, price })} aria-label={tr('wealth_WealthApp.label_sync_now', { label })}>
          <i style={{ background: dot }} />
        </button>
      </span>
    </div>
  );
}

/** Shows the connected account and logs out of Path of Exile after one confirm. The Connect page comes back because `connected` turns false. */
function DisconnectChip({ account }: { account: string }) {
  const toast = useToast();
  const [ask, setAsk] = useState(false);
  const [busy, setBusy] = useState(false);
  const go = () => {
    setBusy(true);
    window.pom.wealth.disconnect().then(
      () => { setAsk(false); setBusy(false); toast({ text: tr('wealth_WealthApp.disconnected_from_path_of_exile'), kind: 'ok' }); },
      () => { setBusy(false); toast({ text: tr('wealth_WealthApp.could_not_disconnect_try_again'), kind: 'error' }); },
    );
  };
  return (
    <>
      <button type="button" className="w-acct" data-r="w-acct" onClick={() => setAsk(true)} title={tr('wealth_WealthApp.signed_in_as_account_click', { account })} aria-label={tr('wealth_WealthApp.disconnect_path_of_exile_account', { account })}>
        <span>{account || tr('wealth_WealthApp.connected')}</span>
        <Icon name="log-out" size={14} />
      </button>
      {ask && (
        <Dialog size="small" icon="user" tone="danger" title={tr('wealth_WealthApp.disconnect_path_of_exile')} subtitle={account} cancelLabel={tr('wealth_WealthApp.cancel')} confirmLabel={tr('wealth_WealthApp.disconnect')} confirmIcon="log-out" confirmBusy={busy} onCancel={() => !busy && setAsk(false)} onConfirm={go}>
          <p className="w-acct-note">{tr('wealth_WealthApp.this_signs_you_out_of')}</p>
        </Dialog>
      )}
    </>
  );
}

/**
 * Archive in the Wealth bar. Wealth keeps one league at a time (the connected one) and its net worth points and sessions carry no league
 * stamp, so there is nothing old to list: the panel says what Wealth holds instead of inventing a split.
 */
function WealthArchive({ v }: { v: WealthView }) {
  const [open, setOpen] = useState(false);
  const league = v.sync.league;
  return (
    <>
      <button type="button" className="w-btn alt" onClick={() => setOpen(true)}><Icon name="history" size={14} />{tr('wealth_WealthApp.archive')}</button>
      {open && <ArchivePanel area="Wealth" current={league || tr('wealth_WealthApp_2.the_current_league')} rows={[]} onClose={() => setOpen(false)}
        emptyText={tr('wealth_WealthApp.no_archived_leagues_wealth_keeps')}
        note={league ? `Wealth holds ${league}: ${v.series.length} net worth ${v.series.length === 1 ? 'point' : 'points'} and ${v.sessions.length} ${v.sessions.length === 1 ? 'session' : 'sessions'}. They are not stamped with a league.` : tr('wealth_WealthApp.no_path_of_exile_account')} />}
    </>
  );
}

/** The stash search in the bar: the Enter hint shows only when the box is wide enough to hold it whole. */
function StashSearch({ q, onChange, onEnter }: { q: string; onChange: (q: string) => void; onEnter: () => void }) {
  const ref = useRef<HTMLInputElement>(null);
  const [wide, setWide] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setWide(el.clientWidth >= 290));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return (
    <span className="w-bsearch" data-r="w-search">
      <input ref={ref} value={q} onChange={(e) => onChange(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && onEnter()} placeholder={wide ? tr('wealth_WealthApp.search_your_stash_enter_to') : tr('wealth_WealthApp.search_your_stash')} aria-label={tr('wealth_WealthApp.search_your_stash')} title={tr('wealth_WealthApp.enter_opens_stash_with_the')} spellCheck={false} />
    </span>
  );
}

function Bell({ s, onPickBuild }: { s: Wealth; onPickBuild: (id: string) => void }) {
  const { inbox, unread, readInbox, go, now } = s;
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLSpanElement>(null);
  useDismiss(ref, open, () => setOpen(false));
  const newCount = s.w?.inboxUnread ?? 0;
  const label = unread ? tr('wealth_WealthApp.count_new_notifications', { count: newCount }) : tr('wealth_WealthApp_2.notifications');
  const top = inbox[0];
  const src = (k: InboxEntry['kind']) => (k === 'price' || k === 'goal' ? tr('wealth_WealthApp_2.market') : k === 'upgrade' ? tr('wealth_WealthApp.upgrade_watch') : tr('wealth_WealthApp_2.snapshot'));
  const goTo = (x: InboxEntry) => {
    if (x.go?.build?.startsWith('lib:')) onPickBuild(x.go.build.slice(4));
    if (x.go) go(x.go.sub as Sub, (x.go.patch ?? {}) as Partial<WealthUi>);
    setOpen(false);
  };
  const verb = (k: InboxEntry['kind']) => (k === 'price' ? tr('wealth_WealthApp.open_the_item') : k === 'goal' ? tr('wealth_WealthApp.open_the_item') : k === 'upgrade' ? tr('wealth_WealthApp.view_match') : tr('wealth_WealthApp_2.open_overview'));
  return (
    <span ref={ref} className="w-bell-wrap">
      <button type="button" className="w-bell" aria-label={label} title={label} aria-haspopup="dialog" aria-expanded={open} onClick={() => { setOpen((o) => !o); readInbox(); }}>
        <Icon name="bell" size={16} />
        {unread && <b>{Math.min(newCount, 9)}</b>}
      </button>
      {open && (
        <div className="w-inbox" data-lg="pop" data-solid="" data-inbox="1" role="dialog" aria-label={tr('wealth_WealthApp.notifications')}>
          <div className="w-inbox-h">
            <Icon name="bell" size={14} style={{ color: 'var(--text-muted)' }} />
            <span>{tr('wealth_WealthApp.notifications')}</span>
            {inbox.length > 0 && <button type="button" className="w-link" onClick={() => void window.pom.wealth.clearInbox()}>{tr('wealth_WealthApp.clear_all')}</button>}
            <button type="button" aria-label={tr('wealth_WealthApp.close_notifications')} onClick={() => setOpen(false)}><Icon name="x" size={12} /></button>
          </div>
          {inbox.length === 0 && <span className="w-inbox-none">{tr('wealth_WealthApp.nothing_new_price_alerts_a')}</span>}
          {top && (
            <>
              <span className="w-inbox-src">{src(top.kind)} · {ago(top.at, now)}</span>
              <span className="w-inbox-t">{msg(top.title)}</span>
              <span className="w-inbox-b">{msg(top.body)}</span>
              <div className="w-inbox-f">
                {top.go && (
                  <button type="button" className="w-btn" onClick={() => goTo(top)}>
                    <Icon name="eye" size={14} />
                    {verb(top.kind)}
                  </button>
                )}
                <button type="button" className="w-btn alt" onClick={() => void window.pom.wealth.removeInbox(top.id)}>
                  <Icon name="x" size={14} />
                  {tr('wealth_WealthApp.dismiss')}
                </button>
              </div>
              {inbox.length > 1 && (
                <div className="w-inbox-more">
                  {inbox.slice(1, 6).map((x) => (
                    <button key={x.id} type="button" onClick={() => goTo(x)}><b>{msg(x.title)}</b><span>{msg(x.body)}</span></button>
                  ))}
                </div>
              )}
            </>
          )}
        </div>
      )}
    </span>
  );
}

function Banners({ s, expired, loadingNote, showPriceNote, onConn, onReconnect }: { s: Wealth; expired: boolean; loadingNote: string; showPriceNote: boolean; onConn: () => void; onReconnect: () => void }) {
  const { w, now } = s;
  if (!w) return null;
  const y = w.sync;
  const items: { key: string; tone: 'warn' | 'bad' | 'info'; text: string; action?: { label: string; run: () => void } }[] = [];
  if (expired) items.push({ key: 'exp', tone: 'bad', text: tr('wealth_WealthApp.your_path_of_exile_session'), action: { label: tr('wealth_WealthApp.reconnect'), run: onReconnect } });
  if (y.phase === 'rate-limited') {
    const secs = Math.max(1, Math.round(((y.resumesAt ?? now) - now) / 1000));
    items.push({ key: 'rl', tone: 'warn', text: tr('wealth_WealthApp.waiting_for_ggg_reading_resumes', { secs: secs >= 90 ? fmtDuration(secs / 60) : secs + 's' }), action: { label: tr('wealth_WealthApp.connection_check'), run: onConn } });
  }
  if (y.phase === 'down') items.push({ key: 'down', tone: 'warn', text: y.message ? msg(y.message) : tr('wealth_WealthApp.path_of_exile_s_api'), action: { label: tr('wealth_WealthApp.connection_check'), run: onConn } });
  if (y.privateProfile) items.push({ key: 'priv', tone: 'info', text: tr('wealth_WealthApp.your_characters_are_private_so') });
  // Stale prices say so: a refresh that failed shows its message even while the last prices stay on screen.
  if (showPriceNote && w.prices.failed && !w.prices.loading) items.push({ key: 'pr', tone: 'warn', text: msg(w.prices.message), action: { label: tr('wealth_WealthApp.retry'), run: () => void window.pom.wealth.retryPrices() } });
  if (loadingNote) items.push({ key: 'load', tone: 'info', text: loadingNote });
  const dg = w.diag[w.diag.length - 1];
  if (dg && y.phase === 'down') items.push({ key: 'diag', tone: 'warn', text: tr('wealth_WealthApp.path_of_exile_answered_in', { problem: msg(dg.problem).replace(/\.$/, '') }), action: { label: tr('wealth_WealthApp.copy_diagnostic'), run: () => void navigator.clipboard.writeText(dg.text) } });
  if (items.length === 0) return null;
  return (
    <div className="w-banners">
      {items.map((b) => (
        <div key={b.key} className={'w-banner ' + b.tone} role={b.tone === 'info' ? 'status' : 'alert'}>
          <Icon name={b.tone === 'bad' ? 'warning' : 'info'} size={14} />
          <span>{b.text}</span>
          {b.action && <button type="button" className="w-btn sm" onClick={b.action.run}>{b.action.label}</button>}
        </div>
      ))}
    </div>
  );
}
