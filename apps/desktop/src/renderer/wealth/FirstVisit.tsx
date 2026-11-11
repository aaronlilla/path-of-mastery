import { useEffect, useState } from 'react';
import { pickLeague, type TabInfo, type WealthView } from '../../shared/wealth.js';
import { Icon, Select } from '../ui.js';
import { Panel } from './wui.js';
import { useDelayedFlag } from '../delayedFlag.js';
import { tr } from '../i18n';
import { item, msg } from './mainText';

interface Props {
  w: WealthView;
  /** Set when the cookie expired: the account stays, only the cookie is asked for. */
  reconnect?: boolean;
  onDone: () => void;
  /** Reconnect only: the dialog's Close button. */
  onClose?: () => void;
}

/** The icon the design draws for a stash tab of this kind. */
function tabIcon(t: TabInfo): string {
  const k = t.type.replace(/Stash$/, '').toLowerCase();
  return /currency/.test(k) ? 'orb' : /fragment/.test(k) ? 'fragment' : /unique/.test(k) ? 'unique' : /map/.test(k) ? 'map' : !t.readable ? 'ban' : 'inbox';
}

/** The line under a tab: why it is counted or not, in the design's words. */
function tabWhy(t: TabInfo): string {
  if (!t.readable) return t.why ? item(t.why) : tr('wealth_FirstVisit.not_readable');
  const k = t.type.replace(/Stash$/, '').toLowerCase();
  if (/currency/.test(k)) return tr('wealth_FirstVisit.always_counted_priced_every_snapshot');
  if (/fragment/.test(k)) return tr('wealth_FirstVisit.counted_scarabs_and_splinters_priced');
  if (/unique/.test(k)) return t.counted ? tr('wealth_FirstVisit.counted_priced_by_base_and') : tr('wealth_FirstVisit.off_by_default');
  if (/map/.test(k)) return t.counted ? tr('wealth_FirstVisit_2.counted') : tr('wealth_FirstVisit.off_mostly_maps_you_will');
  return t.counted ? tr('wealth_FirstVisit_2.counted') : tr('wealth_FirstVisit.off_by_default');
}

export function FirstVisit({ w, reconnect, onDone, onClose }: Props) {
  const [phase, setPhase] = useState<'connect' | 'snap'>('connect');
  const [formOpen, setFormOpen] = useState(false);
  const [connected, setConnected] = useState(false);
  const [account, setAccount] = useState(w.sync.account);
  const [cookie, setCookie] = useState('');
  const [leagues, setLeagues] = useState<string[]>(w.sync.league ? [w.sync.league] : []);
  const [league, setLeague] = useState(w.sync.league);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [tabs, setTabs] = useState<TabInfo[]>([]);
  const [on, setOn] = useState<Record<string, boolean>>({});
  const [saved, setSaved] = useState(true);
  /** Items held per tab, read once after connecting; null while that read is running. */
  const [counts, setCounts] = useState<Record<string, number> | null>(null);
  /** While the count runs: what has come in so far. Path of Exile allows about one stash read every two seconds. */
  const [prog, setProg] = useState<{ done: number; total: number; counts: Record<string, number>; waitMs: number } | null>(null);
  const countAll = () => {
    setCounts(null);
    setProg(null);
    const tick = window.setInterval(() => void window.pom.wealth.countProgress().then((p) => p.running && setProg(p), () => undefined), 1000);
    // prog is kept: the status line may stay up a moment longer (useDelayedFlag), and must keep its last words rather than revert to the opening text.
    const end = (c: Record<string, number>) => {
      window.clearInterval(tick);
      setCounts(c);
    };
    void window.pom.wealth.countTabs().then(end, () => end({}));
  };
  useEffect(() => {
    void window.pom.wealth.leagues().then((l) => {
      setLeagues(l);
      setLeague((cur) => (cur && l.includes(cur) ? cur : pickLeague(l)));
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const [waiting, setWaiting] = useState(false);
  /** While Path of Exile's rate limit is on: when connecting may be tried again, and the seconds left, counted down. */
  const [retryAt, setRetryAt] = useState(0);
  const [left, setLeft] = useState(0);
  useEffect(() => {
    if (!retryAt) return;
    const tick = () => {
      const s = Math.ceil((retryAt - Date.now()) / 1000);
      setLeft(Math.max(0, s));
      if (s <= 0) {
        setRetryAt(0);
        setError('');
      }
    };
    tick();
    const t = window.setInterval(tick, 1000);
    return () => window.clearInterval(t);
  }, [retryAt]);
  const blocked = retryAt > 0 && left > 0;
  const afterConnect = (r: Awaited<ReturnType<typeof window.pom.wealth.signIn>>) => {
    if (!r.ok) {
      if (r.retryAfterSec) setRetryAt(Date.now() + r.retryAfterSec * 1000);
      return void setError(msg(r.error));
    }
    setSaved(r.saved);
    setAccount(r.account);
    if (reconnect) return onDone();
    setTabs(r.tabs);
    setOn(Object.fromEntries(r.tabs.map((x) => [x.id, x.counted && x.readable])));
    setConnected(true);
    setFormOpen(false);
    countAll();
  };
  /** The window sign-in: the player signs in on GGG's own page, in a window of the app's own. */
  const signIn = async () => {
    setWaiting(true);
    setError('');
    const r = await window.pom.wealth.signIn();
    setWaiting(false);
    afterConnect(r);
  };

  const connect = async () => {
    setBusy(true);
    setError('');
    const r = await window.pom.wealth.connect({ account, poesessid: cookie, league });
    setBusy(false);
    if (!r.ok) {
      if (r.retryAfterSec) setRetryAt(Date.now() + r.retryAfterSec * 1000);
      return void setError(msg(r.error));
    }
    setCookie('');
    setSaved(r.saved);
    if (reconnect) return onDone();
    setTabs(r.tabs);
    setOn(Object.fromEntries(r.tabs.map((t) => [t.id, t.counted && t.readable])));
    setConnected(true);
    setFormOpen(false);
    countAll();
  };

  const snapshot = async () => {
    setPhase('snap');
    await window.pom.wealth.setCounted(Object.entries(on).filter(([, v]) => v).map(([k]) => k));
    await window.pom.wealth.firstSnapshot();
    onDone();
  };

  /** Count status shows only when the count is slow, then for at least 400 ms: a count that lands at once never blips "Counting…". */
  const counting = useDelayedFlag(connected && counts === null, 200);
  const n = Object.values(on).filter(Boolean).length;
  const rd = w.sync.reading;
  const items = tabs.reduce((a, t) => a + (on[t.id] ? (counts?.[t.id] ?? t.items) : 0), 0);
  const steps = [tr(n === 1 ? 'h_c_Wf.reading_tab' : 'h_c_Wf.reading_tabs', { n }), items > 0 ? tr('wealth_FirstVisit.pricing_tolocalestring_items_from_po', { items: items.toLocaleString() }) : tr('wealth_FirstVisit.pricing_your_items_from_poe'), tr('wealth_FirstVisit.saving_your_first_snapshot')];
  const stepNow = !rd ? 2 : rd.done / Math.max(1, rd.total) < 1 ? 0 : 1;
  const pct = Math.round(((stepNow + 1) / 3) * 100);

  const card = (
      <Panel className="w-fv-card">
        {reconnect && onClose && (
          <button type="button" className="w-x w-fv-x" aria-label={tr('wealth_FirstVisit.close')} title={tr('wealth_FirstVisit.close')} onClick={onClose}>
            <Icon name="x" size={16} />
          </button>
        )}
        <div className="w-fv-h">
          <span className="w-eyebrow-t">{reconnect ? tr('wealth_FirstVisit.wealth_reconnect') : tr('wealth_FirstVisit.wealth_first_visit')}</span>
          <h2>{reconnect ? tr('wealth_FirstVisit.your_session_cookie_expired') : tr('wealth_FirstVisit.track_what_your_stash_is')}</h2>
          <p>{reconnect ? tr('wealth_FirstVisit.paste_a_fresh_poesessid_to') : tr('wealth_FirstVisit.connect_your_path_of_exile')}</p>
        </div>
        {phase === 'connect' && (
          <div className="w-fv-b">
            <div className="w-fv-row">
              <span className="w-fv-ic"><Icon name="user" size={18} /></span>
              <span className="w-fv-t">
                <b>{tr('wealth_FirstVisit.n1_path_of_exile_account')}</b>
                <i>{connected ? `${tr('h_c_Wf.acct_league', { account, league })}${saved ? '' : ` · ${tr('h_c_Wf.no_secure')}`}` : tr('wealth_FirstVisit_2.opens_pathofexile_com_to_sign_in')}</i>
              </span>
              {!connected && (
                <button type="button" className="w-btn alt" disabled={waiting || blocked} onClick={() => void signIn()}>
                  <Icon name={waiting ? 'loader' : 'link'} size={14} spin={waiting} />
                  {waiting ? tr('wealth_FirstVisit.waiting_for_sign_in') : blocked ? tr('wealth_FirstVisit.try_again_in_left_s', { left }) : reconnect ? tr('wealth_FirstVisit.reconnect') : tr('wealth_FirstVisit.connect')}
                </button>
              )}
              {connected && (
                <span className="w-fv-ok">
                  <Icon name="check-circle" size={14} />
                  {tr('wealth_FirstVisit.connected')}
                </span>
              )}
            </div>
            {error && !formOpen && !connected && <div className="w-err" role="alert">{error}</div>}
            {!connected && (
              <button type="button" className="w-link w-fv-alt" aria-expanded={formOpen} onClick={() => setFormOpen((o) => !o)}>
                {tr('wealth_FirstVisit.paste_a_cookie_instead')}
              </button>
            )}
            {formOpen && !connected && (
              <form className="w-form" onSubmit={(e) => { e.preventDefault(); if ((reconnect || account) && cookie && !busy) void connect(); }}>
                {!reconnect && (
                  <>
                    <label>
                      <span>{tr('wealth_FirstVisit.account_name')}</span>
                      <input value={account} onChange={(e) => setAccount(e.target.value)} placeholder={tr('wealth_FirstVisit.name_1234')} autoComplete="off" spellCheck={false} aria-label={tr('wealth_FirstVisit.account_name')} />
                    </label>
                    <label>
                      <span>{tr('wealth_FirstVisit.league')}</span>
                      <Select value={league} options={leagues.map((l) => ({ value: l, label: l }))} onChange={setLeague} width="100%" ariaLabel={tr('wealth_FirstVisit.league')} />
                    </label>
                  </>
                )}
                <label>
                  <span>{tr('wealth_FirstVisit.poesessid')}</span>
                  <input type="password" value={cookie} onChange={(e) => setCookie(e.target.value)} placeholder={tr('wealth_FirstVisit.n32_character_cookie_value')} autoComplete="off" spellCheck={false} aria-label={tr('wealth_FirstVisit.poesessid')} />
                </label>
                {error && formOpen && <div className="w-err" role="alert">{error}</div>}
                <div className="w-help">
                  <b>{tr('wealth_FirstVisit.where_to_find_it')}</b> {tr('wealth_FirstVisit.sign_in_at_pathofexile_com')}
                </div>
                <div className="w-fv-f">
                  <span />
                  <button type="submit" className="w-btn" disabled={busy || blocked || (!reconnect && !account) || !cookie || !league}>
                    <Icon name={busy ? 'loader' : 'link'} size={14} spin={busy} />
                    {busy ? tr('wealth_FirstVisit.checking') : reconnect ? tr('wealth_FirstVisit.reconnect') : tr('wealth_FirstVisit.check_and_connect')}
                  </button>
                </div>
              </form>
            )}
            {!reconnect && (
              <>
                <div className="w-fv-tabs-wrap" style={{ opacity: connected ? 1 : 0.45 }}>
                  <div className="w-fv-tabs-h"><Icon name="stash" size={16} />{tr('wealth_FirstVisit.n2_tabs_to_count')}<i>{connected ? tr('wealth_FirstVisit.n_of_length_tabs', { n, count: tabs.length }) : ''}</i></div>
                  {/* A fixed slot, there for as long as the tab list is: the status fills it or leaves it empty, so the list never moves. */}
                  {connected && (
                    <div className="w-note-line w-fv-count" role="status">
                      {counting && (prog ? `${tr('h_c_Wf.counting', { done: prog.done, total: prog.total })}${prog.total > prog.done ? ` · ${tr('h_c_Wf.counting_left', { s: Math.max(1, Math.ceil(((prog.total - prog.done) * 2000 + prog.waitMs) / 1000)) })}` : ''}. ${tr('h_c_Wf.counting_tail')}` : tr('wealth_FirstVisit.counting_items_in_each_tab'))}
                    </div>
                  )}
                  {connected ? (
                    <div className="w-fv-tabs" role="group" aria-label={tr('wealth_FirstVisit.stash_tabs')}>
                      {tabs.map((t) => (
                        <button key={t.id} type="button" role="checkbox" aria-checked={!!on[t.id]} aria-disabled={!t.readable} className="w-fv-tab" onClick={() => t.readable && setOn((o) => ({ ...o, [t.id]: !o[t.id] }))} style={{ opacity: t.readable ? 1 : 0.55 }}>
                          <span className="w-fv-cb" data-on={!!on[t.id]}>{on[t.id] && <Icon name="check" size={11} style={{ strokeWidth: 3 }} />}</span>
                          <Icon name={tabIcon(t)} size={15} style={{ color: 'var(--text-muted)' }} />
                          <span className="w-fv-n">{t.name}</span>
                          <span className="w-fv-why">{tabWhy(t)}</span>
                          <span className="w-fv-items">{!t.readable ? '' : counts === null && prog?.counts[t.id] === undefined ? (counting ? tr('wealth_FirstVisit.waiting') : '') : ((counts ?? prog!.counts)[t.id] ?? t.items) > 0 ? tr('wealth_FirstVisit.tolocalestring_items', { value: ((counts ?? prog!.counts)[t.id] ?? t.items).toLocaleString() }) : tr('wealth_FirstVisit.empty')}</span>
                        </button>
                      ))}
                    </div>
                  ) : (
                    <div className="w-fv-tabs w-fv-wait">{tr('wealth_FirstVisit.your_stash_tabs_appear_here')}</div>
                  )}
                </div>
                <div className="w-fv-f">
                  <span className="faint">{tr('wealth_FirstVisit.read_only_nothing_in_your')}</span>
                  <button type="button" className="w-btn lg" aria-disabled={!connected || n === 0} style={{ opacity: connected && n > 0 ? 1 : 0.5 }} onClick={() => connected && n > 0 && void snapshot()}>
                    <Icon name="snapshot" size={16} />
                    {tr('wealth_FirstVisit.take_first_snapshot')}
                  </button>
                </div>
              </>
            )}
          </div>
        )}
        {phase === 'snap' && (
          <div className="w-fv-b" role="status" aria-live="polite">
            <div className="w-prog"><span style={{ width: `${pct}%` }} /></div>
            {steps.map((l, k) => (
              <span key={l} className="w-step" data-on={k <= stepNow}>
                <Icon name={k < stepNow ? 'check-circle' : k === stepNow ? 'loader' : 'dot'} size={15} spin={k === stepNow} />
                {k === 0 && rd ? tr('wealth_FirstVisit.l_tab_total_of_total2', { l, total: Math.min(rd.done + 1, rd.total), total2: rd.total }) : l}
              </span>
            ))}
          </div>
        )}
      </Panel>
  );
  return reconnect ? card : <div className="w-fv" data-screen-label="Wealth / First visit">{card}</div>;
}
