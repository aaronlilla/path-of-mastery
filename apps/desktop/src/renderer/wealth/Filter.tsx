import { useEffect, useMemo, useState } from 'react';
import { fmtChaos } from '../../shared/wealth.js';
import { PICKUP_SECONDS, RULE_PREFIX, hideThreshold, planSuggestions, totalGains, type Suggestion } from '../../shared/wealthFilter.js';
import { newGuidedRule } from '../../shared/lootfilter/guided.js';
import type { GuidedMeta, LabelStyle, Rule } from '../../shared/lootfilter/types.js';
import { STRICTNESS } from '../../shared/lootfilter/styles.js';
import { Icon, useToast } from '../ui.js';
import { LootFilterProvider, useLf } from '../lootfilter/lfStore.js';
import { LabelChip, groundFor } from '../lootfilter/LabelChip.js';
import { Cb, Panel, Seg } from './wui.js';
import type { Wealth } from './useWealth.js';
import { tr } from '../i18n';
import { fmtAgo, item, sugg } from './mainText';

const CORE = new Set(['Chaos Orb', 'Divine Orb', 'Exalted Orb', 'Mirror of Kalandra']);

/** The Wealth "Your filter" screen: it edits the same active loot filter as the Loot Filter area, so one filter exists. */
export function Filter({ s }: { s: Wealth }) {
  return (
    <LootFilterProvider build={null}>
      <FilterInner s={s} />
    </LootFilterProvider>
  );
}

function FilterInner({ s }: { s: Wealth }) {
  const { w, strategies } = s;
  const lf = useLf();
  const toast = useToast();
  const [after, setAfter] = useState(true);
  const [off, setOff] = useState<Record<string, boolean>>({});
  const [flush, setFlush] = useState<{ msg: string } | null>(null);
  if (!w) return null;
  const { divine } = w;
  const rate = w.rate7d;
  const threshold = hideThreshold(rate);
  const have = (id: string) => lf.doc.rules.some((r) => r.id === id && r.enabled);

  // What the player gained over the last 7 days, by item: the evidence every suggestion below is written from.
  const gained = useMemo(() => totalGains(w.sessions, w.now - 7 * 24 * 3600_000), [w.sessions, w.now]);
  const catalog = lf.catalog;
  const suggestions = useMemo<Suggestion[]>(() => {
    if (!catalog) return [];
    const strat = strategies.find((x) => x.yours) ?? strategies.find((x) => w.favs[x.id]);
    return planSuggestions({
      gained,
      rate,
      divine,
      known: (n) => catalog.byName.has(n),
      baseHidden: (n) => !!catalog.byName.get(n)?.hidden,
      haveRule: have,
      spark: (n) => w.rows.find((r) => r.name === n)?.spark ?? [],
      held: w.rows.filter((r) => r.unit !== null).map((r) => ({ name: r.name, qty: r.qty, unit: r.unit as number })),
      strategy: strat ? { name: strat.name, scarabs: strat.scarabRows } : null,
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [catalog, gained, rate, divine, strategies, lf.doc.rules, w.rows, w.favs]);

  const on = (id: string, i: number) => (off[id] === undefined ? i < 3 : !off[id]);
  const picked = suggestions.filter((x, i) => on(x.id, i));
  const writtenAt = lf.lastWriteAt ?? lf.doc.written?.at ?? null;
  const ours = lf.doc.rules.filter((r) => r.id.startsWith(RULE_PREFIX));

  const meta = (g: Suggestion): GuidedMeta => ({ sel: [{ t: 'item', name: g.item }], exc: [], act: g.kind === 'hide' ? 'hide' : g.kind === 'top' || g.kind === 'show' ? 'loud' : 'standout' });
  const apply = () => {
    let p = lf.nextPriority();
    for (const g of picked) {
      const r: Rule = { ...newGuidedRule(g.id, meta(g), catalog, p++, Date.now()), name: sugg(g.title), why: sugg(g.why) };
      lf.addRule(r, sugg(g.title));
    }
    setFlush({ msg: tr('wealth_Filter.count_changes', { count: picked.length }) });
  };
  // The rules above are in state a moment after addRule; the file is generated from that state, so write when it changes.
  const hash = lf.gen?.rulesHash;
  useEffect(() => {
    if (!flush || !lf.gen) return;
    const m = flush.msg;
    setFlush(null);
    void lf.write().then((o) => toast({ text: o?.kind === 'written' ? tr('wealth_Filter.m_written_to_your_game', { value: m }) : o?.kind === 'needs-confirm' ? tr('wealth_Filter.the_file_in_your_game') : tr('wealth_Filter.could_not_write_the_filter'), kind: o?.kind === 'written' ? 'ok' : 'error' }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hash, flush]);
  const restore = () => {
    if (ours.length === 0) return;
    lf.setRules(tr('wealth_Filter.restore_base_filter'), (rs) => rs.filter((r) => !r.id.startsWith(RULE_PREFIX)));
    setFlush({ msg: tr('wealth_Filter.base_filter_restored') });
  };

  const strict = STRICTNESS[lf.doc.setup.strictness]?.name ?? 'Semi-Strict';

  // The preview: real items from the stash and sessions, drawn the way the base filter (and your rules) draw them.
  const preview = useMemo(() => {
    if (!catalog) return [];
    const pool = new Map<string, number>();
    for (const r of w.rows) if (r.unit !== null && !CORE.has(r.name) || r.name === 'Divine Orb') pool.set(r.name, Math.max(pool.get(r.name) ?? 0, (r.unit ?? 0)));
    for (const [n, a] of gained) pool.set(n, Math.max(pool.get(n) ?? 0, a.value / Math.max(1, a.qty)));
    const names = [...pool.keys()].filter((n) => catalog.byName.has(n));
    const ranked = names.sort((a, b) => (pool.get(b) ?? 0) - (pool.get(a) ?? 0));
    const hiders = new Set(suggestions.filter((x, i) => x.kind === 'hide' && on(x.id, i)).map((x) => x.item));
    const bigger = new Set(suggestions.filter((x, i) => x.kind !== 'hide' && on(x.id, i)).map((x) => x.item));
    const lows = names.filter((n) => (pool.get(n) ?? 0) < threshold).sort((a, b) => (pool.get(b) ?? 0) - (pool.get(a) ?? 0));
    const chosen = [...new Set([...ranked.slice(0, 4), ...lows.slice(0, 3), ...hiders])].slice(0, 7);
    const spots: [number, number][] = [[8, 12], [52, 24], [14, 42], [58, 48], [30, 64], [62, 72], [10, 80]];
    return chosen.map((name, i) => {
      const it = catalog.byName.get(name)!;
      const baseHidden = it.hidden;
      const mine = lf.evaluateCatalogItem(it);
      const wasHidden = mine ? !mine.visible : baseHidden;
      const hide = after ? wasHidden || hiders.has(name) : baseHidden;
      const big = after && bigger.has(name);
      const style: LabelStyle = mine?.style ?? it.style;
      return { name, x: spots[i]![0], y: spots[i]![1], style, hide, big };
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [catalog, w.rows, gained, suggestions, after, off, threshold, lf.gen?.rulesHash]);

  return (
    <div className="w-flt" data-r="lay-side" data-screen-label="Wealth / Tab / filter">
      <Panel className="w-flt-l">
        <div className="w-eyebrow">
          <span>{tr('wealth_Filter.your_filter')}</span>
        </div>
        <div className="w-flt-t">{tr('wealth_Filter.priced_for_your_time')}</div>
        <div className="w-flt-rate">
          <span className="faint">{tr('wealth_Filter.your_rate_last_7_days')}</span>
          <b>{rate > 0 ? tr('wealth_Filter.tofixed_div_h', { value: (rate / divine).toFixed(1) }) : tr('wealth_Filter.no_sessions_yet')}</b>
          <span>{tr('wealth_Filter.a_pickup_plus_a_stash', { PICKUP_SECONDS })} <b>{fmtChaos(threshold, divine)}</b> {tr('wealth_Filter.are_hidden')}</span>
        </div>
        <div className="w-flt-kv"><span>{tr('wealth_Filter.base')}</span><span>{`NeverSink ${strict}`}</span></div>
        <div className="w-flt-kv"><span>{tr('wealth_Filter.re_tier')}</span><span>{tr('wealth_Filter.every_pricerefreshminutes_min_from_l', { priceRefreshMinutes: lf.settings.priceRefreshMinutes })}</span></div>
        <div className="w-flt-kv"><span>{tr('wealth_Filter.learns_from')}</span><span>{tr('wealth_Filter.what_you_gain_and_sell')}</span></div>
        <div className="w-flt-sync" data-on={!!writtenAt}>
          <b>{writtenAt ? tr('wealth_Filter.written_to_your_game') : tr('wealth_Filter.not_written_yet')}</b>
          <span className="faint">{writtenAt ? tr('wealth_Filter.filename_in_gamefolder_writtenat_rel', { fileName: lf.doc.fileName, gameFolder: lf.doc.written?.folder || lf.gameFolder || item('your game folder'), writtenAt: fmtAgo(Date.now() - writtenAt) }) : tr('wealth_Filter.apply_writes_the_filter_into')}</span>
          <div className="w-btns inline">
            <button type="button" className="w-btn alt" disabled={ours.length === 0} onClick={restore}>
              <Icon name="history" size={14} />
              {tr('wealth_Filter.restore_base_filter')}
            </button>
          </div>
        </div>
      </Panel>
      <Panel className="w-flt-m">
        <div className="w-eyebrow">
          <span>{tr('wealth_Filter.preview_how_drops_look')}</span>
          <Seg labels={[tr('wealth_Filter_2.after_changes'), tr('wealth_Filter_2.before')]} active={after ? 0 : 1} onPick={(i) => setAfter(i === 0)} label={tr('wealth_Filter.preview')} />
        </div>
        <div className="w-flt-ground" style={{ background: groundFor('dark') }}>
          {lf.baseLoading && <span className="w-none">{tr('wealth_Filter.reading_the_base_filter')}</span>}
          {preview.map((l) => (
            <span key={l.name} className="w-flt-lbl" style={{ left: `${l.x}%`, top: `${l.y}%`, opacity: l.hide ? 0.28 : 1, textDecoration: l.hide ? 'line-through' : 'none' }}>
              <LabelChip name={l.name} style={l.big ? { ...l.style, fs: Math.min(45, (l.style.fs ?? 32) + 8) } : l.style} scale={0.5} />
            </span>
          ))}
          <span className="w-flt-note">{tr('wealth_Filter.struck_through_labels_are_hidden')}</span>
        </div>
      </Panel>
      <Panel className="w-flt-r">
        <div className="w-eyebrow"><span>{tr('wealth_Filter.suggested_changes_length', { count: suggestions.length })}</span></div>
        <div className="w-flt-list">
          {suggestions.map((g, i) => {
            const ck = on(g.id, i);
            return (
              <div key={g.id} role="presentation" className="w-flt-sug" onClick={() => setOff((o) => ({ ...o, [g.id]: ck }))}>
                <Cb on={ck} label={sugg(g.title)} onClick={() => {}} />
                <span className="w-flt-sug-t"><b>{sugg(g.title)}</b><i>{sugg(g.why)}</i></span>
              </div>
            );
          })}
          {suggestions.length === 0 && <div className="w-none">{tr('wealth_Filter.no_new_suggestions_they_appear')}</div>}
        </div>
        <div className="w-flt-apply">
          <button type="button" className="w-btn" disabled={lf.phase === 'writing'} onClick={picked.length ? apply : () => setFlush({ msg: tr('wealth_Filter_2.filter') })}>
            {picked.length ? tr('wealth_Filter.apply_length_and_sync', { count: picked.length }) : tr('wealth_Filter.sync')}
          </button>
        </div>
      </Panel>
    </div>
  );
}
