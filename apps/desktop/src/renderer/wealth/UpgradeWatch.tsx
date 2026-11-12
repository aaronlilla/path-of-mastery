import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { BuildEdit } from '@pom/protocol';
import { fmtChaos } from '../../shared/wealth.js';
import { listingAgeMin, sellerPrice, defaultRule, type TradeListing, type SlotScan, type StatGain, type UpgradeCandidate, type UpgradeView, type WatchedBuild, type WatchRule } from '../../shared/wealthTrade.js';
import { Icon, useDismiss, useToast } from '../ui.js';
import { artFor, slotIcon } from '../gameArt.js';
import { ageText, TradeBanner, useCopy, type LibraryChoice, type PremiumBuild } from './premiumUi.js';
import type { Wealth } from './useWealth.js';
import { Chip, Cb, Empty, Panel, Seg } from './wui.js';
import { label, tr } from '../i18n';
import { item, msg } from './mainText';

const REFRESH_MS = 30_000;

function pollText(v: UpgradeView | null, now: number): string {
  const base = '';
  if (!v) return base;
  const p = v.poll;
  const mins = p.nextAt ? Math.max(1, Math.round((p.nextAt - now) / 60000)) : null;
  if (p.state === 'off') return tr('wealth_UpgradeWatch.base_background_checks_are_off', { base }).trim();
  if (p.state === 'no-cookie') return tr('wealth_UpgradeWatch.base_background_checks_are_paused', { base }).trim();
  if (p.state === 'idle') return tr('wealth_UpgradeWatch.base_background_checks_are_paused_2', { base }).trim();
  if (p.state === 'backoff') return tr('h_c_Uw.backoff', { base, mins: mins ?? tr('h_c_Uw.backoff_few') }).trim();
  return (mins ? tr('h_c_Uw.active_next', { base, mins }) : tr('h_c_Uw.active', { base })).trim();
}

function gainText(g: StatGain | null): string {
  if (!g) return '—';
  if (g.pct !== null && Math.abs(g.before) >= 100) return (g.pct >= 0 ? '+' : '−') + (Math.abs(g.pct) * 100).toFixed(1) + '%';
  const d = g.delta;
  const n = Math.abs(d) >= 100 ? Math.round(Math.abs(d)).toLocaleString('en-US') : String(Math.round(Math.abs(d) * 10) / 10);
  return (d >= 0 ? '+' : '−') + n + (/Resist|Block/.test(g.statId) ? '%' : '');
}
/** Numbers in the notes: whole numbers once they pass a thousand, one decimal below. */
const num = (v: number): string => v.toLocaleString('en-US', { maximumFractionDigits: Math.abs(v) >= 1000 ? 0 : 1 });
/** One entry per stat: Defence mode ranks by Effective HP, which is also the Effective Hit Pool tile, so it must not appear twice. */
const oneEach = (gs: (StatGain | null)[]): StatGain[] => {
  const seen = new Set<string>();
  return gs.filter((g): g is StatGain => !!g).filter((g) => (seen.has(g.statId) ? false : (seen.add(g.statId), true)));
};
const tone = (g: StatGain | null): string => (!g ? 'var(--text-2)' : g.delta > 0 ? 'var(--positive-text)' : g.delta < 0 ? 'var(--negative-text)' : 'var(--text-2)');

export function UpgradeWatch({ s, build, library, onPick, openName, onEquip, onReconnect }: { s: Wealth; build: PremiumBuild | null; library: LibraryChoice[]; onPick: (id: string) => void; openName?: string; onEquip?: (edit: BuildEdit) => Promise<boolean>; onReconnect: () => void }) {
  const { w, fmt, now } = s;
  const toast = useToast();
  const copy = useCopy();
  // Listings the site called "in demand": the next click sends it again with continue, like the site's button.
  const [demand, setDemand] = useState<string | null>(null);
  const travel = async (l: TradeListing) => {
    const r = await window.pom.wealth.travelToListing(l, demand === l.id);
    setDemand(r.inDemand ? l.id : null);
    toast({ text: msg(r.text), kind: r.ok ? 'ok' : 'error', ttl: 3000 });
  };
  const [view, setView] = useState<UpgradeView | null>(null);
  // False until the first read of the watch comes back: the panel stays empty meanwhile, not "no equipped gear" for a few frames.
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [rank, setRank] = useState<0 | 1>(0);
  const [slot, setSlot] = useState<string | null>(null);
  const [sel, setSel] = useState<string | null>(s.ui.wsel);
  // The bell's "View match" selects a match by its listing id.
  useEffect(() => {
    if (s.ui.wsel) setSel(s.ui.wsel);
  }, [s.ui.wsel]);
  const [tryOn, setTryOn] = useState(false);
  const [prefsOpen, setPrefsOpen] = useState(false);
  const prefsRef = useRef<HTMLSpanElement>(null);
  useDismiss(prefsRef, prefsOpen, () => setPrefsOpen(false));
  const [err, setErr] = useState<{ kind: string; message: string } | null>(null);
  const alive = useRef(true);
  useEffect(() => () => void (alive.current = false), []);
  const key = build?.key ?? '';
  const xml = build?.xml ?? '';

  const [watched, setWatched] = useState<WatchedBuild[]>([]);
  const load = useCallback(async () => {
    void window.pom.wealth.upgradeWatched().then((x) => alive.current && setWatched(x));
    if (!build) return setView(null);
    try {
      setView(await window.pom.wealth.upgradeView(build.key, build.xml));
    } finally {
      if (alive.current) setLoaded(true);
    }
  }, [build?.key, build?.xml]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    setSel(s.ui.wsel);
    setSlot(null);
    setErr(null);
    void load();
  }, [key, load]);

  const [progress, setProgress] = useState<string | null>(null);
  const scan = useCallback(
    async (only?: string[]) => {
      if (!build || busy) return;
      setBusy(true);
      setErr(null);
      const list = (only ?? (view?.slots ?? []).filter((x) => !view?.rules[x.slot]?.off).map((x) => x.slot));
      // One slot at a time: results appear as they come, and a rate limit or a refused cookie stops the run at that slot.
      for (const [i, sl] of list.entries()) {
        setProgress(tr('wealth_UpgradeWatch.checking_sl_v2_of_length', { sl: label(sl), value: i + 1, count: list.length }));
        const r = await window.pom.wealth.upgradeScan({ buildXml: build.xml, buildKey: build.key, name: build.name, rank: rank === 0 ? 'dps' : 'ehp', slots: [sl] });
        if (!alive.current) return;
        if (r.ok) setView(r.view);
        else {
          setErr({ kind: r.kind, message: msg(r.message) });
          await load();
          break;
        }
      }
      setProgress(null);
      setBusy(false);
    },
    [build, busy, rank, load, view],
  );

  // The first visit to a build checks it once (the trade search is rate-limited and spaced by the limiter), so the screen opens with matches.
  const autoDone = useRef(new Set<string>());
  useEffect(() => {
    if (!build || !view || view.scannedAt || busy || autoDone.current.has(build.key) || view.slots.length === 0) return;
    if (!w?.sync.connected || w.trade.phase === 'expired' || w.trade.phase === 'no-cookie') return;
    autoDone.current.add(build.key);
    void scan();
  }, [build?.key, view?.scannedAt, view?.slots.length, busy]); // eslint-disable-line react-hooks/exhaustive-deps

  // Background checks run in the main process; this only re-reads what they saved while the screen is open.
  useEffect(() => {
    if (!build) return;
    const i = window.setInterval(() => !busy && void load(), REFRESH_MS);
    return () => window.clearInterval(i);
  }, [build?.key, busy, load]); // eslint-disable-line react-hooks/exhaustive-deps

  const slots = view?.slots ?? [];
  const rules = view?.rules ?? {};
  const scans = view?.scans ?? {};
  const all = useMemo(() => {
    const out: { c: UpgradeCandidate; scan: SlotScan }[] = [];
    for (const sl of slots) {
      const sc = scans[sl.slot];
      if (!sc || rules[sl.slot]?.off) continue;
      for (const c of sc.candidates) if (c.sold || (!c.held && (c.main?.pct ?? -1) * 100 >= (rules[sl.slot]?.minGainPct ?? 3))) out.push({ c, scan: sc });
    }
    const tier = (c: UpgradeCandidate, r: WatchRule) => (c.sold ? 5 : c.held ? 4 : (c.main?.pct ?? -1) * 100 < r.minGainPct ? 3 : c.score === null ? 2 : 1);
    return out.sort((a, b) => tier(a.c, rules[a.c.slot] ?? defaultRule()) - tier(b.c, rules[b.c.slot] ?? defaultRule()) || (b.c.score ?? -1) - (a.c.score ?? -1));
  }, [slots, scans, rules]);
  const cur = all.find((x) => x.c.key === sel) ?? all[0];
  const c = cur?.c;
  const lst = c?.listing;
  const rule = (sl: string): WatchRule => rules[sl] ?? defaultRule();
  const matchCount = (sl: string) => (scans[sl]?.candidates ?? []).filter((x) => !x.held && !x.sold && (x.main?.pct ?? -1) * 100 >= rule(sl).minGainPct).length;
  const checked = Object.values(scans).reduce((a, x) => a + x.checked, 0);
  const patch = async (sl: string, p: Partial<WatchRule>) => {
    await window.pom.wealth.upgradeRule(key, sl, p);
    await load();
  };

  if (!w) return null;
  if (!build) {
    return (
      <div className="w-center">
        <Panel className="w-card">
          <div className="w-later" data-state="no-build">
            <Icon name="eye" size={28} />
            <b>{tr('wealth_UpgradeWatch.pick_a_build_to_watch')}</b>
            <span>{tr('wealth_UpgradeWatch.upgrade_watch_looks_for_listings')}</span>
            {library.length > 0 && (
              <select className="w-select" aria-label={tr('wealth_UpgradeWatch.choose_a_build')} defaultValue="" onChange={(e) => e.target.value && onPick(e.target.value)}>
                <option value="">{tr('wealth_UpgradeWatch.choose_a_build_2')}</option>
                {library.map((b) => (
                  <option key={b.id} value={b.id}>{b.folder ? `${b.folder} / ${b.name}` : b.name}</option>
                ))}
              </select>
            )}
          </div>
        </Panel>
      </div>
    );
  }

  // One failure is shown once: the trade banner when the site's state says it, else the message of the failed check; never both, and not again in the panel or the footer.
  const tradeShown = w.trade.phase !== 'idle' && w.trade.phase !== 'busy';
  const failedScan = Object.values(scans).find((x) => x.error);
  const lastFailed = !!err || !!failedScan;
  const age = lst ? listingAgeMin(lst.indexed, now) : null;
  const over = c?.overBudget ? fmtChaos(c.overBudget, w.divine) : null;
  const heldNote = c?.held;
  const notBetter = view && view.scannedAt && checked > 0 ? Object.values(scans).reduce((a, x) => a + x.candidates.filter((c) => !c.sold && (c.held || (c.main?.pct ?? -1) * 100 < (rules[x.slot]?.minGainPct ?? 3))).length, 0) : null;
  const showWarn = !!(view && failedScan && !err && !tradeShown);
  const equipped = cur ? `${cur.scan.equipped}${cur.scan.equippedBase ? ` (${cur.scan.equippedBase})` : ''}` : '';

  const hdr = lst ? (lst.item.frameType === 3 ? 'unique' : lst.item.frameType === 2 ? 'rare' : lst.item.frameType === 1 ? 'magic' : 'normal') : 'rare';
  const dbl = !!lst?.item.name;
  const hpath = (side: string) => `game/poe/ui/header-${dbl && (hdr === 'rare' || hdr === 'unique') ? 'double-' : ''}${hdr}-${side}.png`;
  const baseArt = lst ? artFor(lst.item.baseType ?? lst.item.typeLine, 'bases') ?? artFor(lst.item.name, 'uniques') : undefined;
  // The other builds that have been checked, as the watch list shows every watched build at once.
  const others = watched
    .filter((x) => x.key !== key && x.key.startsWith('lib:'))
    .map((x) => ({ ...x, id: x.key.slice(4), name: library.find((b) => b.id === x.key.slice(4))?.name }))
    .filter((x): x is typeof x & { name: string } => !!x.name && x.slots.some((s) => !s.rule.off));
  // The picker offers only builds that are not already in the watch list above it.
  const unwatched = library.filter((b) => 'lib:' + b.id !== key && !watched.some((x) => x.key === 'lib:' + b.id && x.slots.some((sl) => !sl.rule.off)));
  const dflt = defaultRule();
  /** A slot shows its rule only when it differs from the default, which is stated once under the build name. */
  const ownRule = (r: WatchRule): boolean => r.off || r.minGainPct !== dflt.minGainPct || r.budgetDiv !== dflt.budgetDiv || r.keepResists !== dflt.keepResists;
  const ruleText = (slotName: string, r: WatchRule = rule(slotName)): string => {
    if (r.off) return tr('wealth_UpgradeWatch_2.paused');
    return `${tr('h_c_Uw.gain_pct', { pct: r.minGainPct, stat: rank === 0 ? 'DPS' : 'EHP' })}${r.keepResists ? `, ${tr('h_c_Uw.keep_resists')}` : ''}${r.budgetDiv ? ` · ${tr('h_c_Uw.up_to_div', { n: r.budgetDiv })}` : ''}`;
  };

  if (!loaded) return <div className="w-watch" data-r="lay-side" data-screen-label="Wealth / Tab / watch" data-state="loading" aria-busy="true" />;

  return (
    <div className="w-watch" data-r="lay-side" data-screen-label="Wealth / Tab / watch" data-state={busy && !all.length ? 'loading' : err ? 'error' : all.length ? 'ready' : 'empty'}>
      <Panel className="w-wl">
        <div className="w-eyebrow">
          <span>{tr('wealth_UpgradeWatch.watches_click_to_pause')}</span>
          <div className="w-wl-ctl">
            <Seg labels={[tr('wealth_UpgradeWatch_2.damage'), tr('wealth_UpgradeWatch_2.defence')]} active={rank} onPick={(i) => setRank(i as 0 | 1)} label={tr('wealth_UpgradeWatch.rank_by')} />
            <button type="button" className="w-btn alt sm" disabled={busy || slots.length === 0} onClick={() => void scan()} title={busy ? tr('wealth_UpgradeWatch.checking') : tr('wealth_UpgradeWatch.check_now')} aria-label={busy ? tr('wealth_UpgradeWatch.checking') : tr('wealth_UpgradeWatch.check_now')}>
              <Icon name="refresh" size={14} />
              <span className="lbl">{busy ? tr('wealth_UpgradeWatch.checking') : tr('wealth_UpgradeWatch.check_now')}</span>
            </button>
          </div>
        </div>
        <div className="w-wl-b">
          <div className="w-wl-build">
            <b title={build.name}>{build.name}</b>
          </div>
          <div className="w-wl-rule">{tr('wealth_UpgradeWatch.default_rule', { rule: ruleText('', dflt) })}</div>
          {slots.length === 0 && <div className="w-note-line">{tr('wealth_UpgradeWatch.this_build_has_no_equipped')}</div>}
          {slots.map((sl) => {
            const r = rule(sl.slot);
            const sc = scans[sl.slot];
            const n = matchCount(sl.slot);
            return (
              <div key={sl.slot} className="w-wslot" data-on={slot === sl.slot} data-off={r.off}>
                <div role="button" tabIndex={0} className="w-wslot-h" onClick={() => void patch(sl.slot, { off: !r.off })} onKeyDown={(e) => e.key === 'Enter' && void patch(sl.slot, { off: !r.off })}>
                  <Cb on={!r.off} label={tr('wealth_UpgradeWatch.watch_slot', { slot: label(sl.slot) })} onClick={(e) => { e.stopPropagation(); void patch(sl.slot, { off: !r.off }); }} />
                  <img className="w-wslot-ic" src={slotIcon(sl.slot)} alt="" draggable={false} />
                  <span className="w-name" title={sc?.rule ? msg(sc.rule) : undefined}><b>{label(sl.slot)}</b>{ownRule(r) && <i>{ruleText(sl.slot)}</i>}</span>
                  <span className="w-wcount" style={{ color: !r.off && n ? 'var(--gold-text)' : 'var(--text-faint)' }}>{r.off ? tr('wealth_UpgradeWatch.off') : sc?.error ? tr('wealth_UpgradeWatch.error') : n ? tr(n > 1 ? 'h_c_Uw.matches' : 'h_c_Uw.match', { n }) : sc ? '—' : ''}</span>
                  <button type="button" className="w-link w-wgear" aria-label={tr('wealth_UpgradeWatch.edit_the_rule_for_slot', { slot: label(sl.slot) })} aria-expanded={slot === sl.slot} title={tr('wealth_UpgradeWatch.edit_the_rule')} onClick={(e) => { e.stopPropagation(); setSlot(slot === sl.slot ? null : sl.slot); }}>
                    <Icon name="settings" size={13} />
                  </button>
                </div>
                {slot === sl.slot && (
                  <div className="w-wrule">
                    <span className="faint">{sc?.rule ? msg(sc.rule) : tr('wealth_UpgradeWatch.checked_the_next_time_you')}</span>
                    <label>{tr('wealth_UpgradeWatch.smallest_gain_that_counts')}<input type="number" min={0} max={200} step={0.5} defaultValue={r.minGainPct} aria-label={tr('wealth_UpgradeWatch.minimum_gain_for_slot', { slot: label(sl.slot) })} onBlur={(e) => void patch(sl.slot, { minGainPct: Number(e.target.value) })} /></label>
                    <label>{tr('wealth_UpgradeWatch.most_you_will_pay_div')}<input type="number" min={0} step={0.5} placeholder={tr('wealth_UpgradeWatch.no_limit')} defaultValue={r.budgetDiv ?? ''} aria-label={tr('wealth_UpgradeWatch.budget_for_slot', { slot: label(sl.slot) })} onBlur={(e) => void patch(sl.slot, { budgetDiv: e.target.value === '' ? null : Number(e.target.value) })} /></label>
                    <div className="w-bulk-b" role="presentation" onClick={() => void patch(sl.slot, { keepResists: !r.keepResists })}><Cb on={r.keepResists} label={tr('wealth_UpgradeWatch.keep_resistances_capped')} onClick={() => {}} />{tr('wealth_UpgradeWatch.keep_resistances_capped')}</div>
                    {r.badBases.length > 0 && (
                      <span className="faint">{tr('wealth_UpgradeWatch.not_these_bases_join', { badBases: r.badBases.join(', ') })} <button type="button" className="w-link" onClick={() => void patch(sl.slot, { badBases: [] })}>{tr('wealth_UpgradeWatch.clear')}</button></span>
                    )}
                    <button type="button" className="w-btn sm" disabled={busy || r.off} onClick={() => void scan([sl.slot])}>{tr('wealth_UpgradeWatch.check_this_slot')}</button>
                  </div>
                )}
              </div>
            );
          })}
          {others.map((o) => (
            <div key={o.key} className="w-wl-other">
              <div className="w-wl-build">
                <b title={o.name}>{o.name}</b>
              </div>
              {!o.slots.some((x) => !x.rule.off && x.matches) && (
                <div role="button" tabIndex={0} className="w-wl-none" onClick={() => onPick(o.id)} onKeyDown={(e) => e.key === 'Enter' && onPick(o.id)}>
                  {o.slots.filter((x) => !x.rule.off).length} {tr('wealth_UpgradeWatch.slots_watched_no_matches')}
                </div>
              )}
              {o.slots.filter((x) => !x.rule.off && x.matches).map((x) => (
                <div key={x.slot} className="w-wslot">
                  <div role="button" tabIndex={0} className="w-wslot-h" title={tr('wealth_UpgradeWatch.show_the_matches_for_name', { name: o.name })} onClick={() => onPick(o.id)} onKeyDown={(e) => e.key === 'Enter' && onPick(o.id)}>
                    <Cb on label={tr('wealth_UpgradeWatch.name_slot_is_watched', { name: o.name, slot: label(x.slot) })} onClick={(e) => { e.stopPropagation(); onPick(o.id); }} />
                    <img className="w-wslot-ic" src={slotIcon(x.slot)} alt="" draggable={false} />
                    <span className="w-name"><b>{label(x.slot)}</b>{ownRule(x.rule) && <i>{ruleText(x.slot, x.rule)}</i>}</span>
                    <span className="w-wcount" style={{ color: x.matches ? 'var(--gold-text)' : 'var(--text-faint)' }}>{x.matches ? tr(x.matches > 1 ? 'h_c_Uw.matches' : 'h_c_Uw.match', { n: x.matches }) : '—'}</span>
                  </div>
                </div>
              ))}
            </div>
          ))}
          {unwatched.length > 0 && (
            <div className="w-wl-add">
              <select className="w-select sm" aria-label={tr('wealth_UpgradeWatch.watch_another_build')} value="pick" onChange={(e) => e.target.value !== 'pick' && onPick(e.target.value)}>
                <option value="pick">{tr('wealth_UpgradeWatch.watch_another_build_2')}</option>
                {!build.open && openName && <option value="">{tr('wealth_UpgradeWatch.openname_open_in_builds', { openName })}</option>}
                {unwatched.map((b) => (
                  <option key={b.id} value={b.id}>{b.folder ? `${b.folder} / ${b.name}` : b.name}</option>
                ))}
              </select>
            </div>
          )}
        </div>
        <div className="w-wl-f">
          <span className="w-wl-f1">{lastFailed ? tr('wealth_UpgradeWatch.the_last_check_did_not_2', { scannedAt: view?.scannedAt ? ` · ${ageText(Math.round((now - view.scannedAt) / 60000))}` : '' }) : view?.scannedAt ? tr('wealth_UpgradeWatch.tolocalestring_listings_checked_scan', { checked: checked.toLocaleString(), scannedAt: ageText(Math.round((now - view.scannedAt) / 60000)) }) : tr('wealth_UpgradeWatch.nothing_checked_yet')}</span>
          <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8 }}><span style={{ flex: 1, minWidth: 0 }}>{pollText(view, now)}</span>
            {view && (
              <span ref={prefsRef} className="w-pop-wrap">
                <button type="button" className="w-link" aria-label={tr('wealth_UpgradeWatch.check_settings')} title={tr('wealth_UpgradeWatch.check_settings')} aria-haspopup="dialog" aria-expanded={prefsOpen} onClick={() => setPrefsOpen((o) => !o)}>
                  <Icon name="settings" size={14} />
                </button>
                {prefsOpen && (
                  <div className="w-pop" data-lg="pop" data-solid="" role="dialog" aria-label={tr('wealth_UpgradeWatch.check_settings')}>
                    <div className="w-bulk-b" role="presentation" onClick={() => void window.pom.wealth.upgradePrefs({ poll: !view.prefs.poll }).then(load)}><Cb on={view.prefs.poll} label={tr('wealth_UpgradeWatch.check_in_the_background')} onClick={() => {}} />{tr('wealth_UpgradeWatch.check_in_the_background')}</div>
                    <div className="w-bulk-b" role="presentation" aria-disabled={!view.prefs.poll || undefined} onClick={() => { if (view.prefs.poll) void window.pom.wealth.upgradePrefs({ os: !view.prefs.os }).then(load); }}><Cb on={view.prefs.os} label={tr('wealth_UpgradeWatch.desktop_notification')} disabled={!view.prefs.poll} onClick={() => {}} />{tr('wealth_UpgradeWatch.desktop_notification')}</div>
                  </div>
                )}
              </span>
            )}
          </div>
        </div>
      </Panel>

      <div className="w-wm">
        <TradeBanner trade={w.trade} now={now} onReconnect={onReconnect} />
        {err && !tradeShown && err.kind !== 'expired' && err.kind !== 'rate-limited' && <div className="w-banner inline bad" role="alert"><Icon name="warning" size={14} /><span>{err.message}</span></div>}
        {busy && <div className="w-banner inline info" role="status"><Icon name="info" size={14} /><span>{w.trade.phase === 'waiting' ? tr('wealth_UpgradeWatch.waiting_for_the_trade_site') : progress ?? tr('wealth_UpgradeWatch.searching_the_trade_site')}</span></div>}
        <Panel className="w-wmatch">
          {!c || !lst ? (
            <Empty
              title={busy ? tr('wealth_UpgradeWatch.looking_for_upgrades') : !view?.scannedAt ? tr('wealth_UpgradeWatch.nothing_checked_yet') : err ? tr('wealth_UpgradeWatch.the_last_check_did_not') : tr('wealth_UpgradeWatch.no_open_matches')}
              body={busy ? tr('wealth_UpgradeWatch.each_listing_is_put_in') : err || tradeShown ? tr('wealth_UpgradeWatch.nothing_new_could_be_checked') : !view?.scannedAt ? tr('wealth_UpgradeWatch.press_check_now_the_app') : Object.values(scans).some((x) => x.total === 0) ? tr('wealth_UpgradeWatch.the_trade_site_had_no') : tr('wealth_UpgradeWatch.you_ll_get_a_notification')}
              action={!busy && <button type="button" className="w-btn" onClick={() => void scan()} disabled={slots.length === 0}>{tr('wealth_UpgradeWatch.check_now')}</button>}
            />
          ) : (
            <div className="w-wm-in" key={c.key}>
              <div className="w-wm-top">
                <span className="w-eyebrow-t">{tr('wealth_UpgradeWatch.match_touppercase_name', { slot: label(c.slot).toUpperCase() })}</span>
                <span className="w-seen" style={{ color: c.sold ? 'var(--text-muted)' : 'var(--text-muted)' }}>
                  {!c.sold && <i className="w-live sm" />}
                  {c.sold ? tr('wealth_UpgradeWatch.sold_or_removed') : tr('wealth_UpgradeWatch.listed_age_still_listed', { age: ageText(age) })}
                </span>
              </div>
              <div className="w-wm-body">
                <div className="w-pcard" data-rarity={hdr}>
                  <div className="w-pcard-h" style={{ backgroundImage: `url(${hpath('left')}), url(${hpath('right')}), url(${hpath('middle')})` }}>
                    <b>{lst.item.name || lst.item.typeLine}</b>
                    {lst.item.name && <span>{lst.item.typeLine}</span>}
                  </div>
                  {baseArt && <div className="w-pcard-art"><img src={baseArt} alt="" draggable={false} /></div>}
                  <div className="w-pcard-mods">
                    {[...(lst.item.implicitMods ?? [])].map((m, i) => <span key={'i' + i} className="imp">{m}</span>)}
                    {[...(lst.item.fracturedMods ?? []), ...(lst.item.explicitMods ?? []), ...(lst.item.craftedMods ?? [])].map((m, i) => <span key={'e' + i}>{m}</span>)}
                    {lst.item.ilvl ? <span className="meta">{tr('wealth_UpgradeWatch.item_level_ilvl', { ilvl: lst.item.ilvl })}</span> : null}
                  </div>
                </div>
                <div className="w-wm-r">
                  <div className="w-mprice">
                    <span className="w-price" title={item(sellerPrice(lst.price))}>{c.priceChaos !== null ? fmt(c.priceChaos) : item(sellerPrice(lst.price))}</span>
                    <span className="faint">{tr('wealth_UpgradeWatch.you_have_networth', { networth: fmt(w.networth) })}</span>
                    {lst.price && c.priceChaos !== null && lst.price.currency !== 'chaos' && <span className="faint">{tr('wealth_UpgradeWatch.asked_price', { price: item(sellerPrice(lst.price)) })}</span>}
                    {c.priceChaos === null && <Chip tone="warning" title={tr('wealth_UpgradeWatch.the_price_book_has_no')}>{tr('wealth_UpgradeWatch.no_price_in_chaos')}</Chip>}
                    {over && <Chip tone="warning">{tr('wealth_UpgradeWatch.over_budget_by_over', { over })}</Chip>}
                    {c.copies && <span className="faint">{tr('wealth_UpgradeWatch.copies_identical_listings_the_cheape', { copies: c.copies })}</span>}
                  </div>
                  <div className="w-wtiles">
                    {oneEach([c.main, c.ehp, ...c.others]).slice(0, 4).map((g, i) => (
                      <div key={g.statId} className="w-tile">
                        <span>{i === 0 && g.statId === c.main?.statId ? label(cur.scan.rankLabel) : label(g.label)}</span>
                        <b style={{ color: tone(g) }} data-stat={g.statId}>{g.delta === 0 ? tr('wealth_UpgradeWatch.no_change') : gainText(g)}</b>
                      </div>
                    ))}
                  </div>
                  <div className="w-note-line gold" role="note">
                    <Icon name="sparkle-fill" size={12} />
                    <span>
                      {tr('wealth_UpgradeWatch.replaces_your_equipped', { equipped })} {c.main?.pct !== null && c.main ? tr('wealth_UpgradeWatch.ranklabel_goes_from_before_to', { rankLabel: label(cur.scan.rankLabel), before: num(c.main.before), after: num(c.main.after) }) : ''}
                      {heldNote ? tr('wealth_UpgradeWatch.held_back_heldnote', { heldNote: msg(heldNote) }) : ''}
                      {c.score !== null ? tr('wealth_UpgradeWatch.tofixed_points_of_gain_per', { score: c.score.toFixed(1) }) : tr('wealth_UpgradeWatch.unpriced_so_it_is_not')}
                    </span>
                  </div>
                  <div className="w-btns wrap">
                    <button type="button" className="w-btn" title={lst.hideoutToken ? tr('wealth_UpgradeWatch.same_as_the_trade_site') : tr('wealth_UpgradeWatch.no_hideout_link_on_this')} onClick={() => void travel(lst)}>
                      {lst.hideoutToken ? (demand === lst.id ? tr('wealth_UpgradeWatch.in_demand_teleport_anyway') : tr('wealth_UpgradeWatch.travel_to_hideout')) : tr('wealth_UpgradeWatch.copy_whisper')}
                    </button>
                    <button type="button" className="w-btn alt" onClick={() => void window.pom.app.openExternal(cur.scan.link)}>
                      {tr('wealth_UpgradeWatch.open_on_trade_site')}
                      <Icon name="external" size={12} />
                    </button>
                    <button type="button" className="w-btn alt" onClick={() => setTryOn((v) => !v)} aria-expanded={tryOn}>
                      <Icon name="tree" size={14} />
                      {tr('wealth_UpgradeWatch.try_it_on_the_build')}
                    </button>
                    <button type="button" className="w-link" onClick={() => void window.pom.wealth.upgradeDismiss(key, c.slot, c.key, 'base').then(load)}><Icon name="x" size={12} />{tr('wealth_UpgradeWatch.not_this_base')}</button>
                    <button type="button" className="w-link" onClick={() => void window.pom.wealth.upgradeDismiss(key, c.slot, c.key, 'price').then(load)}><Icon name="coins" size={12} />{tr('wealth_UpgradeWatch.too_expensive')}</button>
                  </div>
                  {tryOn && (
                    <div className="w-tryon" role="region" aria-label={tr('wealth_UpgradeWatch.try_it_on')}>
                      <b>{tr('wealth_UpgradeWatch.what_the_engine_says')}</b>
                      {oneEach([c.main, c.ehp, ...c.others]).map((g) => (
                        <div key={g.statId} className="w-kv"><span>{label(g.label)}</span><span>{num(g.before)} → {num(g.after)} ({gainText(g)})</span></div>
                      ))}
                      {build.open && onEquip ? (
                        <button
                          type="button"
                          className="w-btn"
                          onClick={() => void onEquip({ kind: 'setItem', slot: c.slot, itemText: c.itemText }).then((ok) => toast({ text: ok ? tr('wealth_UpgradeWatch.equipped_in_slot_undo_is', { slot: label(c.slot) }) : tr('wealth_UpgradeWatch.the_engine_did_not_take'), kind: ok ? 'ok' : 'error' }))}
                        >
                          {tr('wealth_UpgradeWatch.equip_it_in_slot', { slot: label(c.slot) })}
                        </button>
                      ) : (
                        <span className="faint">{tr('wealth_UpgradeWatch.open_this_build_in_builds')}</span>
                      )}
                    </div>
                  )}
                </div>
              </div>
            </div>
          )}
        </Panel>
      </div>

      {(all.length > 0 || notBetter !== null || showWarn) && <Panel className="w-wr">
        <div className="w-eyebrow"><span>{tr('wealth_UpgradeWatch.recent_matches')}</span></div>
        <div className="w-body">
          {all.map(({ c: x, scan: sc }) => {
            const g = x.main;
            const art = artFor(x.listing.item.baseType ?? x.listing.item.typeLine, 'bases');
            return (
              <div key={x.key} role="button" tabIndex={0} className="w-wrow" data-on={cur?.c.key === x.key} data-sold={x.sold} onClick={() => { setSel(x.key); setTryOn(false); }} onKeyDown={(e) => e.key === 'Enter' && setSel(x.key)}>
                <span className="w-wthumb">{art && <img src={art} alt="" draggable={false} />}</span>
                <span className="w-name"><b>{x.listing.item.name || x.listing.item.typeLine}</b><i>{label(x.slot)} · {ageText(listingAgeMin(x.listing.indexed, now))}</i></span>
                <span className="r">{x.priceChaos !== null ? fmt(x.priceChaos) : item(sellerPrice(x.listing.price))}</span>
                <span className="w-wchip">
                  {x.sold ? <Chip>{tr('wealth_UpgradeWatch.sold_or_removed')}</Chip> : x.held ? <Chip tone="warning">{tr('wealth_UpgradeWatch.held_back')}</Chip> : x.overBudget ? <Chip tone="warning">{tr('wealth_UpgradeWatch.over_budget')}</Chip> : <Chip tone={g && g.delta > 0 ? 'positive' : 'neutral'}>{label(sc.rankLabel)} {gainText(g)}</Chip>}
                </span>
              </div>
            );
          })}
        </div>
        {notBetter !== null && <div className="w-note-line">{notBetter} {tr('wealth_UpgradeWatch.checked_listings_were_not_better')}</div>}
        {showWarn && <div className="w-note-line warn">{failedScan?.error ? msg(failedScan.error.message) : ''}</div>}
      </Panel>}
    </div>
  );
}
