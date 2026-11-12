import { useEffect, useMemo, useState } from 'react';
import { fmtChaos, fmtHM, fmtPct, fmtSigned, sharesOf, type Cat, type NetPoint, type SessionView } from '../../shared/wealth.js';
import type { UpgradeView } from '../../shared/wealthTrade.js';
import type { PremiumBuild } from './premiumUi.js';
import { Icon } from '../ui.js';
import { CAT_COLOUR, catName, change, Chip, Eyebrow, ItemIcon, Panel, Seg, Spark } from './wui.js';
import type { Wealth } from './useWealth.js';
import { tr } from '../i18n';
import { fmtAgo, item, msg, sessName } from './mainText';

const RANGES = [tr('wealth_Overview_2.session'), tr('wealth_Overview_2.t_24h'), tr('wealth_Overview_2.t_7_days'), tr('wealth_Overview_2.league')];
const CAT_ART: Record<string, [string, string?]> = { cur: ['Divine Orb'], frag: ['Simulacrum Splinter'], scar: ['Scarab of Wisps'], rare: ['Vermillion Ring', 'bases'], uniq: ['Mageblood', 'uniques'], map: ['Strand Map', 'maps'], other: ['Stacked Deck'] };
const RANGE_WORDS = [tr('wealth_Overview_2.this_session'), tr('wealth_Overview_2.in_24_hours'), tr('wealth_Overview_2.this_week'), tr('wealth_Overview_2.this_league')];

function windowStart(range: number, w: NonNullable<Wealth['w']>): number {
  const now = w.now;
  if (range === 0) {
    const s = w.running ?? w.sessions[0];
    return s ? s.start : now - 24 * 3600_000;
  }
  return range === 1 ? now - 24 * 3600_000 : range === 2 ? now - 7 * 24 * 3600_000 : 0;
}

function pickPoints(series: NetPoint[], from: number): NetPoint[] {
  // The point just before the window anchors the left edge, so the change over the window is complete.
  const inside = series.filter((p) => p.t >= from);
  const before = [...series].reverse().find((p) => p.t < from);
  return before ? [before, ...inside] : inside;
}

/** The best saved upgrade match the player can pay for with what the stash is worth now. Reads what the last scan saved: no live call. */
function useTopUpgrade(build: PremiumBuild | null, networth: number) {
  const [view, setView] = useState<UpgradeView | null>(null);
  const key = build?.key ?? '';
  useEffect(() => {
    let on = true;
    if (build) void window.pom.wealth.upgradeView(build.key, build.xml).then((v) => on && setView(v));
    else setView(null);
    return () => void (on = false);
  }, [key]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!build || !view) return null;
  let best: { gain: string; at: number } | null = null;
  for (const sc of Object.values(view.scans)) {
    if (view.rules[sc.slot]?.off) continue;
    for (const c of sc.candidates) {
      if (c.sold || c.held || !c.main || c.main.delta <= 0 || c.priceChaos === null || c.priceChaos > networth) continue;
      if ((c.main.pct ?? 0) * 100 < (view.rules[sc.slot]?.minGainPct ?? 3)) continue;
      const g = c.main.pct !== null && Math.abs(c.main.before) >= 100 ? `+${(c.main.pct * 100).toFixed(1)}%` : `+${Math.round(c.main.delta).toLocaleString('en-US')}`;
      const rank = sc.rankStat.includes('EHP') ? 'EHP' : 'DPS';
      const score = c.score ?? 0;
      if (!best || score > best.at) best = { gain: `${g} ${rank}`, at: score };
    }
  }
  return best ? { name: build.name, gain: best.gain } : null;
}

export function Overview({ s, build, onUpgrade }: { s: Wealth; build: PremiumBuild | null; onUpgrade: () => void }) {
  const { w, ui, fmt, go, patch } = s;
  if (!w) return null;
  const pts = useMemo(() => pickPoints(w.series, windowStart(ui.range, w)), [w, ui.range]);
  // With no prices the total reads zero because nothing could be valued, not because the stash is empty: show that, never a loss against it.
  const noPrices = w.prices.lines === 0;
  const first = pts[0]?.nw ?? w.networth;
  const delta = w.networth - first;
  const hasHist = pts.length >= 2 && !noPrices;
  const lastPriced = [...w.series].reverse().find((p) => p.nw > 0);
  const chart = useMemo(() => {
    if (pts.length < 2 || w.prices.lines === 0) return null;
    const t0 = pts[0]!.t;
    const t1 = pts[pts.length - 1]!.t || t0 + 1;
    const mn = Math.min(...pts.map((p) => p.nw)) * 0.97;
    const mx = Math.max(...pts.map((p) => p.nw)) * 1.02 || 1;
    const P = pts.map((p, i) => `${i ? 'L' : 'M'}${(((p.t - t0) / (t1 - t0 || 1)) * 900).toFixed(1)} ${(200 - ((p.nw - mn) / (mx - mn || 1)) * 200).toFixed(1)}`).join(' ');
    const day = ui.range >= 2;
    const at = (t: number) => new Date(t).toLocaleString(undefined, day ? { month: 'short', day: 'numeric' } : { hour: '2-digit', minute: '2-digit' });
    return { line: P, area: `${P} L900 200 L0 200Z`, from: at(t0), to: at(t1), hi: fmtChaos(mx, w.divine), lo: fmtChaos(mn, w.divine) };
  }, [pts, ui.range, w.divine]);
  const run = w.running;
  const upgrade = useTopUpgrade(build, w.networth);

  // Rate by activity, this week.
  const week = w.now - 7 * 24 * 3600_000;
  const byName = new Map<string, { maps: number; min: number; net: number; icon: SessionView['icon'] }>();
  for (const x of w.sessions.filter((x) => x.end >= week)) {
    const a = byName.get(x.name) ?? { maps: 0, min: 0, net: 0, icon: x.icon };
    a.maps += x.mapsUsed;
    a.min += x.minutes;
    a.net += x.net;
    byName.set(x.name, a);
  }
  const rates = [...byName.entries()].map(([name, a]) => ({ name, maps: a.maps, min: a.min, dph: a.net / w.divine / (a.min / 60), icon: a.icon })).sort((a, b) => b.dph - a.dph).slice(0, 5);

  // Movers: held items worth at least 20c whose price moved most in the last 24 hours (the last two daily points of the price history).
  const movers = w.rows
    .filter((r) => r.cat !== 'rare' && r.unit !== null && r.unit >= 20 && r.spark.length >= 2 && r.qty > 0)
    .map((r) => ({ r, c: change(r.spark.slice(-2)) }))
    .filter((m) => m.c !== 0)
    .sort((a, b) => Math.abs(b.c) - Math.abs(a.c))
    .slice(0, 5);

  // Breakdown by category, low end.
  const cats = new Map<string, number>();
  for (const r of w.rows) {
    if (r.unit === null) continue;
    const k: string = r.cat === 'card' || r.cat === 'gem' || r.cat === 'ess' || r.cat === 'other' ? 'other' : r.cat;
    cats.set(k, (cats.get(k) ?? 0) + r.unit * r.qty);
  }
  const brk = [...cats.entries()].sort((a, b) => b[1] - a[1]);
  const shares = sharesOf(brk.map(([, v]) => v));
  const total = w.networth || 1;

  // Put it to work, in the design's order: the best upgrade you can pay for, rares that need a price check, the goal.
  const work: { text: string; chip: string; tone: 'positive' | 'gold' | 'neutral'; go: () => void }[] = [];
  if (upgrade) work.push({ text: tr('wealth_Overview.you_can_afford_the_top', { name: upgrade.name }), chip: upgrade.gain, tone: 'positive', go: onUpgrade });
  const tabName = new Map(w.tabs.map((x) => [x.id, x.name]));
  const unsure = new Map<string, { n: number; sum: number; id: string }>();
  for (const r of w.rows) {
    if (r.cat !== 'rare' || r.priced === 'exact') continue;
    const id = r.tabIds[0] ?? '';
    const a = unsure.get(id) ?? { n: 0, sum: 0, id };
    a.n += r.qty;
    a.sum += r.unit ?? 0;
    unsure.set(id, a);
  }
  const worst = [...unsure.values()].sort((a, b) => b.n - a.n)[0];
  if (worst) work.push({ text: tr('wealth_Overview.tolocalestring_rare_v2_in_id', { value: worst.n.toLocaleString(), value2: worst.n === 1 ? '' : 's', id: tabName.get(worst.id) ?? item('your stash') }), chip: worst.sum > 0 ? `~${fmt(worst.sum)}` : tr('wealth_Overview_2.no_price_yet'), tone: 'gold', go: () => go('stash', { cat: 'rare', tab: worst.id || 'all', q: '' }) });
  const goal = w.goal ? s.market.find((m) => m.key === w.goal) : null;
  if (goal) {
    const left = goal.chaos - w.networth;
    const rate = w.rate7d;
    work.push({ text: tr('wealth_Overview.goal_name', { name: goal.name }), chip: left > 0 ? tr('wealth_Overview.left_to_go_rate', { left: fmt(left), rate: rate > 0 ? ` · ~${Math.ceil(left / rate)}h` : '' }) : tr('wealth_Overview_2.reached'), tone: 'neutral', go: () => go('market', { mi: goal.key, mq: '', mcat: 'all' }) });
  }
  work.push({ text: tr('wealth_Overview.hide_the_loot_that_slows'), chip: tr('wealth_Overview.your_filter'), tone: 'neutral', go: () => go('filter') });
  if (w.unpriced > 0 && work.length < 3) work.push({ text: tr('wealth_Overview.tolocalestring_items_in_your_stash', { unpricedCount: w.unpricedCount.toLocaleString() }), chip: tr('wealth_Overview.count_kinds', { count: w.unpriced }), tone: 'gold', go: () => go('stash', { cat: 'unpriced', tab: 'all', q: '' }) });

  if (w.rows.length === 0) {
    return (
      <div className="w-grid-ov">
        <Panel className="w-wide">
          <Eyebrow>{tr('wealth_Overview.net_worth')}</Eyebrow>
          <div className="w-reading">{w.sync.reading ? tr('wealth_Overview.reading_your_stash_label', { label: msg(w.sync.reading.label) }) : tr('wealth_Overview.waiting_for_the_first_read')}</div>
        </Panel>
      </div>
    );
  }

  return (
    <div className="w-ov">
        <div className="w-col w-s4">
        <Panel>
          <Eyebrow right={
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
              {!run && (
                <button type="button" className="w-btn sm" onClick={() => void window.pom.wealth.startSession(tr('wealth_Overview_2.session'))}>
                  <Icon name="plus" size={14} />
                  {tr('wealth_Overview.start_one_now')}
                </button>
              )}
              <Seg labels={RANGES} active={ui.range} onPick={(i) => patch({ range: i as 0 | 1 | 2 | 3 })} label={tr('wealth_Overview.net_worth_range')} />
            </span>
          }>{tr('wealth_Overview.net_worth')}</Eyebrow>
          <div className="w-nw">
            <span className="w-nw-big">{noPrices ? tr('wealth_Overview.no_prices') : tr('wealth_Overview.tofixed_div', { value: (w.networth / w.divine).toFixed(1) })}</span>
            {noPrices ? <Chip tone="warning">{lastPriced ? tr('wealth_Overview.last_priced_divine_v2', { divine: fmtChaos(lastPriced.nw, w.divine), value: fmtAgo(w.now - lastPriced.t) }) : tr('wealth_Overview.nothing_to_value_yet')}</Chip> : hasHist ? <Chip tone={delta >= 0 ? 'positive' : 'negative'}>{`${delta >= 0 ? '▲' : '▼'} ${fmtChaos(Math.abs(delta), w.divine)} ${RANGE_WORDS[ui.range]}`}</Chip> : <Chip>{tr('wealth_Overview.history_starts_now')}</Chip>}
            {!noPrices && <span className="w-nw-rate">{tr('wealth_Overview.tolocalestring_chaos', { networth: Math.round(w.networth).toLocaleString(), divine: Math.round(w.divine) })}</span>}
          </div>
          {chart ? (
            <div className="w-chart-w">
              <div className="w-chart-c">
                <svg viewBox="0 0 900 200" preserveAspectRatio="none" width="100%" height="200" className="w-chart" role="img" aria-label={tr('wealth_Overview.net_worth_over_time')}>
                  <path d="M0 0H900M0 66H900M0 133H900M0 200H900" stroke="rgba(var(--line-rgb),.06)" vectorEffect="non-scaling-stroke" />
                  <path d={chart.area} fill="rgba(var(--accent-rgb),.12)" />
                  <path d={chart.line} fill="none" stroke="var(--gold-400)" strokeWidth="2" vectorEffect="non-scaling-stroke" />
                </svg>
                <div className="w-chart-x" aria-hidden="true"><span>{chart.from}</span><span>{chart.to}</span></div>
              </div>
              <div className="w-chart-y" aria-hidden="true"><span>{chart.hi}</span><span>{chart.lo}</span></div>
            </div>
          ) : (
            <div className="w-chart-none" style={{ height: 200 }}>{noPrices ? tr('wealth_Overview.the_chart_returns_when_prices') : tr('wealth_Overview.history_starts_now_the_chart')}</div>
          )}
        </Panel>
        <Panel>
          <Eyebrow>{tr('wealth_Overview.movers_in_your_stash_24h')}</Eyebrow>
          <div className="w-rows">
            {movers.map(({ r, c }) => (
              <button key={r.key} type="button" className="w-tr w-mover" onClick={() => go('market', { mq: r.name, mi: r.name, mcat: 'all' })}>
                <ItemIcon name={r.art} cat={r.cat} {...(r.artCat ? { artCat: r.artCat } : {})} />
                <span className="w-name">
                  {r.name}
                  <i>×{r.qty.toLocaleString()}</i>
                </span>
                <Spark data={r.spark} />
                <span className="r" style={{ color: Math.abs(c) < 0.005 ? 'var(--text-faint)' : c > 0 ? 'var(--positive-text)' : 'var(--negative-text)' }}>{fmtPct(c)}</span>
              </button>
            ))}
            {movers.length === 0 && <div className="w-none">{tr('wealth_Overview.nothing_in_your_stash_has')}</div>}
          </div>
        </Panel>
        <Panel>
          <Eyebrow>{tr('wealth_Overview.breakdown_click_to_open')}</Eyebrow>
          <div className="w-pad">
            <div className="w-stack" aria-hidden="true">
              {brk.map(([k, v]) => (
                <span key={k} style={{ width: `${(v / total) * 100}%`, background: k === 'other' ? 'rgba(var(--line-rgb),.3)' : CAT_COLOUR[k as Cat] }} />
              ))}
            </div>
          </div>
          {brk.map(([k, v], bi) => (
            <button key={k} type="button" className="w-brk" onClick={() => go('stash', { cat: k === 'other' ? 'other' : k, tab: 'all', q: '' })}>
              <ItemIcon name={CAT_ART[k]?.[0] ?? k} cat={(k === 'other' ? 'other' : k) as Cat} {...(CAT_ART[k]?.[1] ? { artCat: CAT_ART[k]![1] } : {})} />
              <span className="w-name"><span className="w-swatch" style={{ background: k === 'other' ? 'rgba(var(--line-rgb),.3)' : CAT_COLOUR[k as Cat] }} aria-hidden="true" />{k === 'other' ? tr('wealth_Overview.everything_else') : catName(k as Cat)}</span>
              <span className="r">{fmt(v)}</span>
              <span className="r faint">{shares[bi]}%</span>
              <i className="w-chev">›</i>
            </button>
          ))}
          {brk.length === 0 && <div className="w-none">{tr('wealth_Overview.nothing_is_priced_yet')}</div>}
        </Panel>
        </div>
        <div className="w-col w-s2">
        {run && <RunCard run={run} s={s} />}
        <Panel>
          <Eyebrow>{tr('wealth_Overview.rate_by_activity_this_week')}</Eyebrow>
          <div className="w-rows">
            <div className="w-th w-rate">
              <span />
              <span>{tr('wealth_Overview.activity')}</span>
              <span className="r">{tr('wealth_Overview.maps')}</span>
              <span className="r">{tr('wealth_Overview.time')}</span>
              <span className="r">{tr('wealth_Overview.div_h')}</span>
            </div>
            {rates.map((r) => (
              <button key={r.name} type="button" className="w-tr w-rate" onClick={() => go('sessions', { sess: null })}>
                <ItemIcon bare name={r.icon.name} cat={r.icon.cat} {...(r.icon.artCat ? { artCat: r.icon.artCat } : {})} />
                <span className="w-name">{item(r.name)}</span>
                <span className="r faint">{r.maps || '—'}</span>
                <span className="r">{fmtHM(r.min)}</span>
                <span className="r" style={{ color: r.dph >= 0 ? 'var(--positive-text)' : 'var(--negative-text)' }}>{r.dph.toFixed(1)}</span>
              </button>
            ))}
            {rates.length === 0 && <div className="w-none">{tr('wealth_Overview.play_a_map_with_the')}</div>}
          </div>
        </Panel>
        <Panel>
          <Eyebrow>{tr('wealth_Overview.put_it_to_work')}</Eyebrow>
          {work.slice(0, 3).map((a) => (
            <button key={a.text} type="button" className="w-act" onClick={a.go}>
              <span>{a.text}</span>
              <Chip tone={a.tone}>{a.chip}</Chip>
              <i>›</i>
            </button>
          ))}
          {work.length === 0 && <div className="w-none">{tr('wealth_Overview.nothing_to_act_on_right')}</div>}
        </Panel>
        </div>
    </div>
  );
}

function RunCard({ run, s }: { run: SessionView; s: Wealth }) {
  const { w, go, fmt } = s;
  if (!w) return null;
  const left = w.sync.nextLootAt ? w.sync.nextLootAt - w.now : null;
  const next = left === null ? '' : left <= 30_000 ? ` · ${tr('h_c_Wo.next_snapshot_now')}` : ` · ${tr('h_c_Wo.next_snapshot_in', { m: Math.ceil(left / 60000) })}`;
  return (
    <Panel className="w-run w-s2">
      <div className="w-run-h">
        <span className="w-live" />
        <span className="w-eyebrow-t">{tr('wealth_Overview.session_running')}</span>
        <span className="w-name run-name" title={sessName(run)}>{sessName(run)}</span>
      </div>
      <div className="w-run-v">
        <span className="w-run-net">{fmtSigned(run.net, w.divine)}</span>
        <span className="w-run-meta">{tr('wealth_Overview.minutes_min_tofixed_div_h', { minutes: Math.round(run.minutes), value: (run.perHour / w.divine).toFixed(1) })}</span>
      </div>
      <span className="w-run-sub">
        {tr('wealth_Overview.count_maps', { count: run.mapsUsed })} {tr('wealth_Overview.used_next', { next })}
      </span>
      <div className="w-btns">
        <button type="button" className="w-btn alt" onClick={() => void window.pom.wealth.endSession()}>
          <Icon name="stop" size={14} />
          {tr('wealth_Overview.end_session')}
        </button>
        <button type="button" className="w-btn alt" onClick={() => go('sessions', { sess: run.id })}>
          <Icon name="external" size={14} />
          {tr('wealth_Overview.open_in_sessions')}
        </button>
      </div>
    </Panel>
  );
}
