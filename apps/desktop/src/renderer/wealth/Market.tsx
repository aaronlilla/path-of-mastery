import { useEffect, useMemo, useState } from 'react';
import { fmtPct, marketRowsFor, ownedOf, type Cat, type MarketRow, type StashRow } from '../../shared/wealth.js';
import { Icon, useToast } from '../ui.js';
import { Cb, catName, change, Chip, ItemIcon, LineChart, Panel, Spark, sparkTitle } from './wui.js';
import type { Wealth } from './useWealth.js';
import { useDelayedFlag } from '../delayedFlag.js';
import { tr } from '../i18n';
import { cxText, fmtOld, item, msg, standardPriceText } from './mainText';

const MC: [string, string][] = [['all', tr('wealth_Market_2.all')], ['cur', tr('wealth_Market_2.currency')], ['frag', tr('wealth_Market_2.fragments')], ['scar', tr('wealth_Market_2.scarabs')], ['ess', tr('wealth_Market_2.essences')], ['card', tr('wealth_Market_2.divination')], ['uniq', tr('wealth_Market_2.uniques')], ['gem', tr('wealth_Market_2.gems')]];
const PAGE = 200;
const MC_ICON: Record<string, [string, string?]> = { all: ['Stacked Deck'], cur: ['Divine Orb'], frag: ['Simulacrum Splinter'], scar: ['Scarab of Wisps'], ess: ['Deafening Essence of Scorn'], card: ['The Apothecary'], uniq: ['Mageblood', 'uniques'], gem: ['Cyclone', 'gems'] };

export function Market({ s }: { s: Wealth }) {
  const { w, ui, patch, market, fmt, now } = s;
  const toast = useToast();
  const [shown, setShown] = useState(PAGE);
  if (!w) return null;
  // What the player holds, matched to each Market row by its price line, never by name alone (a corrupted level 21 gem is not the level 20 one).
  const held = useMemo(() => {
    const m = new Map<string, StashRow[]>();
    for (const r of w.rows) m.set(r.name, [...(m.get(r.name) ?? []), r]);
    return m;
  }, [w.rows]);
  const own = (r: MarketRow) => ownedOf(held.get(r.name) ?? [], r);
  const q = ui.mq.trim().toLowerCase();
  const listed = useMemo(() => marketRowsFor(market, w.rows, { q: ui.mq, owned: ui.owned }), [market, w.rows, ui.mq, ui.owned]);
  const rows = useMemo(() => listed.filter((r) => (ui.mcat === 'all' || r.cat === ui.mcat) && (!q || r.name.toLowerCase().includes(q)) && (!ui.owned || own(r).versions.length > 0)).sort((a, b) => b.chaos - a.chaos), [listed, ui.mcat, q, ui.owned, held]);
  const counts = (k: string) => (k === 'all' ? market.length : market.filter((r) => r.cat === k).length);
  const sel: MarketRow | undefined = listed.find((r) => r.key === ui.mi || r.name === ui.mi) ?? rows[0];
  const mine = sel ? own(sel) : null;
  const mh = mine?.qty ?? 0;
  const goalRow = w.goal ? market.find((r) => r.key === w.goal) : undefined;
  const rate = w.rate7d;
  const left = sel && w.goal === sel.key ? sel.chaos - w.networth : 0;
  // The same item's price in Standard, asked of poe.ninja once per category and kept for an hour.
  const [std, setStd] = useState<{ key: string; chaos: number | null; divine: number; failed?: boolean } | null>(null);
  const selKey = sel?.key ?? '';
  useEffect(() => {
    let on = true;
    if (selKey) void window.pom.wealth.standardPrice(selKey).then((r) => on && setStd({ key: selKey, chaos: r.chaos, divine: r.divine, ...(r.failed ? { failed: true } : {}) }));
    return () => void (on = false);
  }, [selKey]);
  const stdSlow = useDelayedFlag(!!sel && (!std || std.key !== sel.key), 200);
  const stdText = standardPriceText(sel, std, stdSlow);

  return (
    <div className="w-market">
      <Panel className="w-mcats">
        {MC.map(([k, l]) => (
          <button key={k} type="button" aria-pressed={ui.mcat === k} className="w-mcat" data-empty={counts(k) === 0 ? 'true' : undefined} title={l} onClick={() => { patch({ mcat: k }); setShown(PAGE); }}>
            <ItemIcon name={MC_ICON[k]![0]} cat="other" {...(MC_ICON[k]![1] ? { artCat: MC_ICON[k]![1] } : {})} size={26} />
            <span>{l}</span>
            <i>{counts(k)}</i>
          </button>
        ))}
      </Panel>
      <Panel className="w-tbl">
        <div className="w-tool">
          <label className="w-search">
            <input value={ui.mq} onChange={(e) => { patch({ mq: e.target.value }); setShown(PAGE); }} placeholder={tr('wealth_Market.search_prices')} aria-label={tr('wealth_Market.search_prices')} />
          </label>
          <div className="w-bulk-b" role="presentation" onClick={() => patch({ owned: !ui.owned })}>
            <Cb on={ui.owned} label={tr('wealth_Market.in_my_stash_only')} onClick={() => {}} />
            {tr('wealth_Market.in_my_stash_only')}
          </div>
        </div>
        <div className="w-grid-h m">
          <span />
          <span className="w-h">{tr('wealth_Market.item')}</span>
          <span className="w-h r" title={w.prices.fetchedAt ? tr('wealth_Market.poe_ninja_league_fetchedat', { league: w.sync.league, fetchedAt: fmtOld(now - w.prices.fetchedAt) }) : tr('wealth_Market.poe_ninja')}>{tr('wealth_Market.price')}</span>
          <span className="w-h">{tr('wealth_Market.n7_days')}</span>
          <span className="w-h r">{tr('wealth_Market.change')}</span>
          <span className="w-h r">{tr('wealth_Market.you_have')}</span>
          <span className="w-h r">{tr('wealth_Market.value')}</span>
        </div>
        <div className="w-body">
          {rows.slice(0, shown).map((r) => {
            const c = change(r.spark);
            const h = own(r).qty;
            return (
              <div key={r.key} role="button" tabIndex={0} className="w-grid-r m" data-on={sel?.key === r.key} onClick={() => patch({ mi: r.key })} onKeyDown={(e) => e.key === 'Enter' && patch({ mi: r.key })}>
                <ItemIcon name={r.art} cat={r.cat} {...(r.artCat ? { artCat: r.artCat } : {})} {...(r.base ? { base: r.base } : {})} {...(r.kind ? { kind: r.kind } : {})} />
                <span className="w-name" title={`${catName(r.cat as Cat)} · ${r.listings !== undefined ? tr('h_c_Wm.listings_ninja', { n: r.listings.toLocaleString() }) : tr('h_c_Wm.ninja_price')}`}>{r.name}{r.variant && <i>{item(r.variant)}</i>}</span>
                <span className="r">{fmt(r.chaos)}</span>
                <Spark data={r.spark} title={sparkTitle(r.spark, fmt)} />
                <span className="r" style={{ color: r.spark.length > 1 && Math.abs(c) >= 0.005 ? (c > 0 ? 'var(--positive-text)' : 'var(--negative-text)') : 'var(--text-faint)' }}>{r.spark.length > 1 ? fmtPct(c) : '—'}</span>
                <span className="r">{h ? h.toLocaleString() : ''}</span>
                <span className="r">{h ? fmt(h * r.chaos) : ''}</span>
              </div>
            );
          })}
          {rows.length === 0 && (
            <div className="w-empty">
              <b>{market.length === 0 ? tr('wealth_Market.no_prices_loaded') : tr('wealth_Market.no_prices_match')}</b>
              <span>{market.length === 0 ? (w.prices.message ? msg(w.prices.message) : tr('wealth_Market.poe_ninja_has_not_answered')) : tr('wealth_Market.try_another_search')}</span>
            </div>
          )}
          {rows.length > shown && (
            <button type="button" className="w-more" onClick={() => setShown((n) => n + PAGE)}>
              {tr('wealth_Market.show_shown_more_of_shown2', { shown: Math.min(PAGE, rows.length - shown), shown2: rows.length - shown })}
            </button>
          )}
        </div>
      </Panel>
      <Panel className="w-mdet">
        {sel ? (
          <>
            <div className="w-item-h">
              <ItemIcon name={sel.art} cat={sel.cat} {...(sel.artCat ? { artCat: sel.artCat } : {})} {...(sel.base ? { base: sel.base } : {})} {...(sel.kind ? { kind: sel.kind } : {})} size={64} />
              <span className="w-name big disp" title={`${sel.name} · ${sel.variant ? item(sel.variant) : catName(sel.cat as Cat)}${sel.listings !== undefined ? ` · ${tr('h_c_Wm.listings_n', { n: sel.listings.toLocaleString() })}` : ''}`}><b>{sel.name}</b><i>{sel.variant ? item(sel.variant) : catName(sel.cat as Cat)}</i></span>
            </div>
            <div className="w-mprice">
              <span className="w-price">{fmt(sel.chaos)}</span>
              {sel.spark.length > 1 ? <Chip tone={Math.round(change(sel.spark) * 100) === 0 ? 'neutral' : change(sel.spark) > 0 ? 'positive' : 'negative'}>{tr('wealth_Market.spark_7_days', { spark: fmtPct(change(sel.spark)) })}</Chip> : <Chip>{tr('wealth_Market.new_this_league')}</Chip>}
            </div>
            <LineChart data={sel.spark} height={110} />
            <div className="w-kv"><span>{tr('wealth_Market.standard_price')}</span><span title={std?.failed ? tr('wealth_Market.poe_ninja_did_not_answer') : tr('wealth_Market.poe_ninja_standard_league')}>{stdText}{sel.cx && <span title={tr('wealth_Market.official_currency_exchange_volume_we')}>{` · ${tr('wealth_Market.ggg_exchange')} ${cxText(sel.cx, now, fmt)}`}</span>}</span></div>
            <div className="w-kv"><span>{tr('wealth_Market.you_have_2')}</span><span>{mh ? `${mh.toLocaleString()} · ${fmt(mine!.value)}` : (mine && mine.versions.length ? tr('wealth_Market.none_of_this_version') : tr('wealth_Market.none'))}</span></div>
            {mine && mine.versions.length > 1 && mine.versions.map((v, i) => (
              <div key={i} className="w-kv"><span>{v.exact ? tr('wealth_Market.this_version') : (v.label ? item(v.label) : tr('wealth_Market.another_version'))}</span><span title={tr('wealth_Market.priced_on_its_own_line')}>{`${v.qty.toLocaleString()} · ${fmt(v.value)}`}</span></div>
            ))}
            <div className="w-kv"><span>{tr('wealth_Market.goal')}</span><span>{w.goal === sel.key ? (left > 0 ? (rate > 0 ? tr('h_c_Wm.to_go_rate', { left: fmt(left), h: Math.ceil(left / rate), rate: (rate / w.divine).toFixed(1) }) : tr('h_c_Wm.to_go', { left: fmt(left) })) : tr('wealth_Market.reached')) : '—'}</span></div>
            <div className="w-btns wrap">
              <button type="button" className="w-btn alt" onClick={() => { const on = w.alerts[sel.key] === undefined; void window.pom.wealth.setAlert(sel.key, on).then(() => toast({ text: on ? tr('wealth_Market.alert_set_name_moves_alertpct', { name: sel.name, alertPct: w.alertPct }) : tr('wealth_Market.alert_removed'), kind: 'ok' })); }}>
                {w.alerts[sel.key] !== undefined ? tr('wealth_Market.alert_on_alertpct', { alertPct: w.alertPct }) : tr('wealth_Market.price_alert')}
              </button>
              {w.alerts[sel.key] !== undefined && (
                <label className="w-alertat" title={tr('wealth_Market.how_far_the_price_must')}><span>{tr('wealth_Market.alert_at')}</span><input type="number" min={0.1} max={100} step={0.5} aria-label={tr('wealth_Market.alert_threshold_percent')} defaultValue={w.alertPct} key={w.alertPct} onBlur={(e) => { const v = Number(e.currentTarget.value); if (v > 0) void window.pom.wealth.setAlertPct(v); }} /><span>%</span></label>
              )}
            </div>
            <div className="w-btns wrap">
              <button type="button" className="w-btn alt" onClick={() => { const on = w.goal !== sel.key; void window.pom.wealth.setGoal(on ? sel.key : null).then(() => toast({ text: on ? tr('wealth_Market.goal_set_name', { name: sel.name }) : tr('wealth_Market.goal_removed'), kind: 'ok' })); }}>
                {w.goal === sel.key ? tr('wealth_Market.remove_goal') : tr('wealth_Market.set_as_goal')}
              </button>
              <button type="button" className="w-btn alt" onClick={() => void window.pom.app.openExternal(`https://www.pathofexile.com/trade/search/${encodeURIComponent(w.sync.league)}?q=${encodeURIComponent(JSON.stringify({ query: { term: sel.name } }))}`)}>
                {tr('wealth_Market.open_on_trade_site')}
                <Icon name="external" size={12} />
              </button>
            </div>
            {goalRow && w.goal !== sel.key && <div className="w-note-line">{tr('wealth_Market.goal_name', { name: goalRow.name })}</div>}
          </>
        ) : (
          <div className="w-empty"><b>{tr('wealth_Market.pick_an_item')}</b><span>{tr('wealth_Market.prices_history_and_what_you')}</span></div>
        )}
      </Panel>
    </div>
  );
}
