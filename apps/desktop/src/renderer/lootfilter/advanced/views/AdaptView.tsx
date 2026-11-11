import { useMemo, useState } from 'react';
import type { LfNav } from '../../LootFilterArea';
import { formatPrice, useLf } from '../../lfStore';
import { LabelChip } from '../../LabelChip';
import { Icon, Switch, useToast } from '../../../ui';
import type { LabelStyle } from '../../../../shared/lootfilter/types.js';
import { STRICTNESS } from '../../../../shared/lootfilter/styles.js';
import { levelSuggestion, visibilityChanges } from '../../../../shared/lootfilter/adapt.js';
import { Eyebrow, GroundBox, Head, Page, Panel, ago, plain, useGround } from '../strictness/kit';
import { usePlay } from '../../usePlay';
import { useDropSuggestion } from '../../useDropSuggestion';
import { useBuildRules } from '../../buildRulesHook';
import { useRetier } from '../retier/useRetier';
import { applyPriceMoves, priceRules } from '../retier/apply';
import { addProposal, type ProposedChange } from '../diffStore';
import { afterLook, currentLook } from '../review/build';
import { tr } from '../../../i18n';
import { lfBuild, lfText } from '../../mainText';

const PRICE_APPLY_CAP = 25;

type Watch = 'level' | 'gear' | 'build' | 'price' | 'drops';

interface Card {
  id: string;
  watch: Watch;
  tag: string;
  /** The fact it starts from. */
  line: string;
  /** What it asks. */
  question: string;
  chips: { name: string; style: LabelStyle }[];
  count: string;
  /** What the Earlier list says once it is applied. */
  done: string;
  apply: () => void;
  review: () => void;
}

const WATCH: { key: Watch; label: string; hint: string }[] = [
  { key: 'level', label: tr('lootfilter_advanced_views_AdaptView.character_level_and_area'), hint: tr('lootfilter_advanced_views_AdaptView.suggests_strictness_changes_as_you') },
  { key: 'gear', label: tr('lootfilter_advanced_views_AdaptView.gear_you_equip'), hint: tr('lootfilter_advanced_views_AdaptView.suggests_rules_for_what_you') },
  { key: 'drops', label: tr('lootfilter_advanced_views_AdaptView.your_drops'), hint: tr('lootfilter_advanced_views_AdaptView.suggests_showing_valuable_loot_the') },
  { key: 'price', label: tr('lootfilter_advanced_views_AdaptView.prices'), hint: tr('lootfilter_advanced_views_AdaptView.suggests_tier_moves_when_prices') },
  { key: 'build', label: tr('lootfilter_advanced_views_AdaptView.build_changes'), hint: tr('lootfilter_advanced_views_AdaptView.suggests_updates_when_your_build') },
];

interface Entry {
  k: 'Applied' | 'Dismissed';
  t: string;
  at: number;
}

import { plural } from './plural';
const list = (l: string[]): string => (l.length <= 1 ? l.join('') : l.length === 2 ? tr('lootfilter_advanced_views_AdaptView.v1_and_v2', { value: l[0], value2: l[1] }) : tr('lootfilter_advanced_views_AdaptView.join_and_length_more', { value: l.slice(0, 2).join(', '), value2: l.length - 2 }));

/** Adapt inbox: suggestions the app can prove from the player's own data. Nothing changes until it is applied. */
export function AdaptView({ nav }: { nav: LfNav }) {
  const lf = useLf();
  const toast = useToast();
  const [ground] = useGround();
  const rt = useRetier();
  const play = usePlay();
  const br = useBuildRules();
  const dr = useDropSuggestion();
  const [done, setDone] = useState<Record<string, 'Applied' | 'Dismissed'>>({});

  const watchState = (lf.ui.adaptWatch ?? {}) as Record<string, boolean>;
  const watching = (k: string): boolean => watchState[k] !== false;
  const dismissed = (lf.ui.adaptDismissed ?? {}) as Record<string, true>;
  const history = (Array.isArray(lf.ui.adaptHistory) ? lf.ui.adaptHistory : []) as Entry[];
  const remember = (k: Entry['k'], t: string): void => lf.setUi('adaptHistory', [{ k, t, at: Date.now() }, ...history].slice(0, 12));

  const strictness = lf.doc.setup.strictness;

  const cards = useMemo<Card[]>(() => {
    const out: Card[] = [];
    const sampleChips = (names: string[], n: number): { name: string; style: LabelStyle }[] => {
      const priced = names
        .map((nm) => ({ nm, p: lf.prices?.byName[nm]?.chaos ?? 0, it: lf.catalog?.byName.get(nm) }))
        .filter((x) => x.it)
        .sort((a, b) => b.p - a.p)
        .slice(0, n);
      return priced.map((x) => ({ name: x.nm, style: lf.evaluateCatalogItem(x.it!)?.style ?? x.it!.style }));
    };

    // LEVEL: area levels from Client.txt, or the build's level when there is no log.
    const lvl = levelSuggestion(play.summary, br.facts?.level ?? null, strictness, !!lf.doc.setup.build?.on);
    if (lvl) {
      const ch = visibilityChanges(lf.hidden, strictness, lvl.toStrictness);
      const n = ch.hidden.length + ch.shown.length;
      const names = ch.hidden.length ? ch.hidden : ch.shown;
      out.push({
        id: lvl.id,
        watch: 'level',
        tag: tr('lootfilter_advanced_views_AdaptView_2.level'),
        line: lfText(lvl.line),
        question: lfText(lvl.question),
        chips: sampleChips(names, 2),
        count: n ? plural(n, 'change') : tr('lootfilter_advanced_views_AdaptView.strictness_only'),
        done: lfText(lvl.done),
        apply: () => lf.edit(tr('lootfilter_advanced_views_AdaptView.strictness_name', { name: STRICTNESS[lvl.toStrictness]!.name }), (d) => ({ ...d, setup: { ...d.setup, strictness: lvl.toStrictness } })),
        review: () => {
          const sample = names.find((nm) => lf.catalog?.byName.has(nm)) ?? names[0];
          const before = sample ? currentLook(lf, sample) : { name: STRICTNESS[strictness]!.name, style: {} };
          const change: ProposedChange = {
            id: `${lvl.id}:0`,
            group: tr('lootfilter_advanced_views_AdaptView_2.strictness'),
            what: tr('lootfilter_advanced_views_AdaptView_2.set_strictness_to', { name: STRICTNESS[lvl.toStrictness]!.name }),
            why: lfText(lvl.line),
            before,
            after: ch.hidden.length ? { ...before, hidden: true, tag: tr('lootfilter_advanced_views_AdaptView_2.hidden') } : { ...before, hidden: false },
            affected: n,
            setup: { strictness: lvl.toStrictness },
            status: 'pending',
          };
          addProposal({ id: `adapt:${lvl.id}`, source: 'Adapt', title: lfText(lvl.question).replace(/[?？]$/, ''), changes: [change], createdAt: Date.now() });
          nav.setAdvancedView('diff');
        },
      });
    }

    // GEAR and BUILD: what the open build now uses against the rules that came from it.
    const have = new Set(lf.doc.rules.filter((r) => r.source === 'build').map((r) => r.id));
    const fresh = br.proposals.filter((p) => !have.has(p.id));
    const addBuild = (ps: typeof fresh): void => {
      const lowest = Math.min(-1000, ...lf.doc.rules.filter((r) => r.source === 'build').map((r) => r.priority));
      const now = Date.now();
      lf.setRules(tr('lootfilter_advanced_views_AdaptView.added_rules_from_the_build'), (rs) => [...rs, ...ps.map((p, i) => ({ ...p.rule, priority: lowest - 1 - i, createdAt: now }))]);
    };
    const reviewBuild = (id: string, title: string, ps: typeof fresh): void => {
      const changes: ProposedChange[] = ps.map((p) => {
        const nm = p.rule.targets[0]?.conditions?.find((c) => c.key === 'BaseType')?.values[0] ?? p.title;
        const before = currentLook(lf, nm);
        return { id: `${id}:${p.id}`, group: title, what: lfBuild(p.title), why: lfBuild(p.why), before, after: { name: nm, style: p.rule.style ?? {} }, rule: p.rule, status: 'pending' as const };
      });
      addProposal({ id: `adapt:${id}`, source: 'Adapt', title, changes, createdAt: Date.now() });
      nav.setAdvancedView('diff');
    };
    const gear = fresh.filter((p) => /^build:(base|up|res):/.test(p.id));
    if (gear.length) {
      const bases = [...new Set(gear.filter((p) => p.id.startsWith('build:base:')).map((p) => p.title))];
      out.push({
        id: `gear:${gear.map((g) => g.id).join(',')}`,
        watch: 'gear',
        tag: tr('lootfilter_advanced_views_AdaptView_2.gear'),
        line: bases.length ? tr(bases.length === 1 ? 'h_lootB_Adapt.equip_one' : 'h_lootB_Adapt.equip_other', { list: list(bases) }) : tr('lootfilter_advanced_views_AdaptView.your_build_s_numbers_call', { value: plural(gear.length, 'rule') }),
        question: tr(bases.length ? 'h_lootB_Adapt.add_for_gear' : 'h_lootB_Adapt.add_for_them', { what: plural(gear.length, 'rule') }),
        chips: gear.slice(0, 3).map((g) => ({ name: g.title, style: g.rule.style ?? {} })),
        count: plural(gear.length, 'change'),
        done: tr('lootfilter_advanced_views_AdaptView.added_length_for_gear_from', { value: plural(gear.length, 'rule') }),
        apply: () => addBuild(gear),
        review: () => reviewBuild('gear', tr('lootfilter_advanced_views_AdaptView.rules_for_your_gear'), gear),
      });
    }
    const gems = fresh.filter((p) => p.id.startsWith('build:gem:'));
    const stale = lf.doc.rules.filter((r) => r.source === 'build' && r.id.startsWith('build:') && !br.proposals.some((p) => p.id === r.id));
    if (br.hasBuild && lf.doc.setup.followBuild && gems.length) {
      out.push({
        id: `build:gems:${gems.map((g) => g.id).join(',')}`,
        watch: 'build',
        tag: tr('lootfilter_advanced_views_AdaptView_2.build'),
        line: tr(gems.length === 1 ? 'h_lootB_Adapt.gems_one' : 'h_lootB_Adapt.gems_other', { list: list(gems.map((g) => g.title)) }),
        question: tr('lootfilter_advanced_views_AdaptView.add_rules_for_these_gems'),
        chips: gems.slice(0, 3).map((g) => ({ name: g.title, style: g.rule.style ?? {} })),
        count: plural(gems.length, 'change'),
        done: tr('lootfilter_advanced_views_AdaptView.added_length_from_a_build', { value: plural(gems.length, 'gem rule') }),
        apply: () => addBuild(gems),
        review: () => reviewBuild('gems', tr('lootfilter_advanced_views_AdaptView.rules_for_new_gems'), gems),
      });
    }
    if (br.hasBuild && lf.doc.setup.followBuild && stale.length) {
      out.push({
        id: `build:stale:${stale.map((r) => r.id).join(',')}`,
        watch: 'build',
        tag: tr('lootfilter_advanced_views_AdaptView_2.build'),
        line: tr(stale.length === 1 ? 'h_lootB_Adapt.stale_one' : 'h_lootB_Adapt.stale_other', { what: plural(stale.length, 'rule'), list: list(stale.map((r) => r.name ?? tr('lootfilter_advanced_views_AdaptView_2.an_item'))) }),
        question: tr(stale.length === 1 ? 'h_lootB_Adapt.remove_one' : 'h_lootB_Adapt.remove_other'),
        chips: stale.slice(0, 3).map((r) => ({ name: r.name ?? tr('lootfilter_advanced_views_AdaptView_2.rule'), style: r.style ?? {} })),
        count: plural(stale.length, 'change'),
        done: tr('lootfilter_advanced_views_AdaptView.removed_length_the_build_no', { value: plural(stale.length, 'rule') }),
        apply: () => lf.setRules(tr('lootfilter_advanced_views_AdaptView.removed_rules_the_build_no'), (rs) => rs.filter((r) => !stale.some((s) => s.id === r.id))),
        review: () => nav.openAdvanced('customize', { ruleId: stale[0]!.id }),
      });
    }

    // DROPS: loot from the player's sessions that the filter hides although it is worth picking up.
    const ds = dr.suggestion;
    if (ds) {
      out.push({
        id: ds.id,
        watch: 'drops',
        tag: tr('lootfilter_advanced_views_AdaptView_2.drops'),
        line: ds.line,
        question: ds.question,
        // The look each item gets once shown (its tier's look), not the hidden look it has now.
        chips: dr
          .rules(-1)
          .map((r, i) => ({ nm: ds.names[i]!, r, p: lf.prices?.byName[ds.names[i]!]?.chaos ?? 0 }))
          .sort((a, b) => b.p - a.p)
          .slice(0, 3)
          .map((x) => ({ name: x.nm, style: afterLook(lf, x.r, { ...currentLook(lf, x.nm), hidden: false }).style })),
        count: plural(ds.names.length, 'change'),
        done: ds.done,
        apply: () => {
          const batch = { id: lf.newId('b'), name: ds.done };
          const made = dr.rules(lf.nextPriority()).map((r) => ({ ...r, batch }));
          lf.setRules(ds.done, (rs) => [...rs, ...made]);
        },
        review: () => {
          const rules = dr.rules(-1);
          const changes: ProposedChange[] = rules.map((r, i) => {
            const nm = ds.names[i]!;
            const before = currentLook(lf, nm);
            return { id: `drops:${nm}`, group: tr('lootfilter_advanced_views_AdaptView_2.your_drops'), what: tr('lootfilter_advanced_views_AdaptView_2.show', { nm: nm }), why: r.why ?? ds.line, before, after: afterLook(lf, r, { ...before, hidden: false }), affected: 1, rule: r, status: 'pending' as const };
          });
          addProposal({ id: 'adapt:drops', source: 'Adapt', title: ds.question.replace(/\?$/, ''), changes, createdAt: Date.now() });
          nav.setAdvancedView('diff');
        },
      });
    }

    // PRICES.
    const rows = rt.rows.filter((r) => !r.done);
    if (rows.length) {
      // A price more than ten times off its tier is more often two items sharing a name than a real move, so the card
      // leads with the moves that are plausible. Retier still lists every one.
      const sane = rows.filter((r) => r.price / r.fromMedian <= 10 && r.price / r.fromMedian >= 0.1);
      const lead = sane.length ? sane : rows;
      const top = lead.slice(0, PRICE_APPLY_CAP);
      const first = lead[0]!;
      const fmt = (c: number): string => formatPrice(c, lf.prices?.divine ?? 0, lf.settings.currencyUnit);
      out.push({
        id: `price:${rows.length}:${first.item.name}`,
        watch: 'price',
        tag: tr('lootfilter_advanced_views_AdaptView_2.prices'),
        line: tr(first.pct >= 0 ? 'h_lootB_Adapt.price_above' : 'h_lootB_Adapt.price_below', { name: first.item.name, price: fmt(first.price), pct: Math.abs(first.pct).toLocaleString(), median: fmt(first.fromMedian), type: first.typeLabel, from: first.fromName }),
        question: tr('lootfilter_advanced_views_AdaptView.length_would_move_tiers_2', { value: plural(rows.length, 'item') }),
        chips: lead.slice(0, 3).map((r) => ({ name: r.item.name, style: r.from.style })),
        count: rows.length > top.length ? tr('lootfilter_advanced_views_AdaptView.length_of_length2_changes', { count: top.length, count2: rows.length }) : plural(rows.length, 'change'),
        done: tr('lootfilter_advanced_views_AdaptView.moved_length_to_new_tiers', { value: plural(top.length, 'item') }),
        apply: () => void applyPriceMoves(lf, top),
        review: () => {
          const rules = priceRules(lf, rows.slice(0, 150), -1);
          const changes: ProposedChange[] = rows.slice(0, 150).map((r, i) => ({
            id: `price:${r.item.name}`,
            group: `${r.typeLabel}`,
            what: tr('lootfilter_advanced_views_AdaptView_2.moves_from_to', { name: r.item.name, fromName: r.fromName, toName: r.toName }),
            why: tr('lootfilter_advanced_views_AdaptView.price_fits_toname_better_than', { price: fmt(r.price), toName: r.toName, fromName: r.fromName, pct: r.pct > 0 ? '+' : '', pct2: r.pct }),
            before: { name: r.item.name, style: r.from.style },
            after: { name: r.item.name, style: r.to.style },
            affected: 1,
            rule: rules[i]!,
            status: 'pending' as const,
          }));
          addProposal({ id: 'adapt:price', source: 'Adapt', title: tr('lootfilter_advanced_views_AdaptView.length_would_move_tiers', { value: plural(rows.length, 'item') }), changes, createdAt: Date.now() });
          nav.setAdvancedView('diff');
        },
      });
    }
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dr.suggestion, play.summary, br.facts, br.proposals, br.hasBuild, strictness, lf.hidden, lf.catalog, lf.prices, lf.doc.rules, lf.doc.setup.followBuild, rt.rows]);

  const visible = cards.filter((c) => watching(c.watch) && !dismissed[c.id] && done[c.id] !== 'Dismissed');
  const pending = visible.filter((c) => !done[c.id]);

  const apply = (c: Card): void => {
    c.apply();
    setDone((d) => ({ ...d, [c.id]: 'Applied' }));
    remember('Applied', c.done);
    toast({ text: tr('lootfilter_advanced_views_AdaptView.done_undo_is_in_the', { done: c.done }), kind: 'ok' });
  };
  const dismiss = (c: Card): void => {
    lf.setUi('adaptDismissed', { ...dismissed, [c.id]: true });
    setDone((d) => ({ ...d, [c.id]: 'Dismissed' }));
    remember('Dismissed', c.line.replace(/\.$/, ''));
  };
  const applyAll = (): void => {
    for (const c of pending) apply(c);
  };

  const noLog = !play.loading && play.info && !play.info.found;
  const facts = br.facts;

  return (
    <Page>
      <Head title={tr('lootfilter_advanced_views_AdaptView.adapt_inbox')} sub={pending.length ? tr('lootfilter_advanced_views_AdaptView.length_from_your_play', { value: plural(pending.length, 'suggestion') }) : tr('lootfilter_advanced_views_AdaptView.nothing_waiting')}>
        {pending.length > 1 && (
          <button type="button" className="adv-s-btn" style={{ height: 32, borderColor: 'rgba(var(--line-rgb),.14)', color: 'var(--text-strong)' }} onClick={applyAll}>
            <Icon name="check-circle" size={15} />
            {tr('lootfilter_advanced_views_AdaptView.apply_all_length', { count: pending.length })}
          </button>
        )}
      </Head>
      <div className="adv-s-two">
        <div className="adv-s-col">
          {visible.map((c) => {
            const d = done[c.id];
            return (
              <div key={c.id} className={'lf-card adv-s-sug' + (d ? ' done' : '')}>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6, minWidth: 0 }}>
                  <Eyebrow>{c.tag}</Eyebrow>
                  <span className="adv-s-muted">{c.line}</span>
                  <span style={{ color: 'var(--text-strong)', fontSize: 14, lineHeight: 1.4 }}>{c.question}</span>
                  {c.chips.length > 0 && (
                    <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 2 }}>
                      {c.chips.map((ch) => (
                        <GroundBox key={ch.name} kind={ground}>
                          <LabelChip name={ch.name} style={plain(ch.style)} fontPx={15} bright={ground === 'bright'} />
                        </GroundBox>
                      ))}
                    </div>
                  )}
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 8 }}>
                  <span style={{ color: d === 'Applied' ? 'var(--positive-text)' : 'var(--text-faint)', fontSize: 12.5 }}>{d ? (d === 'Applied' ? tr('h_lootB_Misc.applied') : tr('h_lootB_Adapt.dismissed')) : c.count}</span>
                  {!d && (
                    <div style={{ display: 'flex', gap: 6 }}>
                      <button type="button" className="adv-s-btn ghost sm" onClick={() => dismiss(c)}>
                        <Icon name="x" size={14} />
                        {tr('lootfilter_advanced_views_AdaptView.dismiss')}
                      </button>
                      <button type="button" className="adv-s-btn sm" onClick={() => apply(c)}>
                        <Icon name="check" size={14} />
                        {tr('lootfilter_advanced_views_AdaptView.apply')}
                      </button>
                      <button type="button" className="adv-s-btn gold sm" onClick={c.review}>
                        <Icon name="eye" size={14} />
                        {tr('lootfilter_advanced_views_AdaptView.review')}
                      </button>
                    </div>
                  )}
                </div>
              </div>
            );
          })}
          {visible.length === 0 && (
            <Panel>
              <Eyebrow>{tr('lootfilter_advanced_views_AdaptView.all_clear')}</Eyebrow>
              <span className="adv-s-strong">{tr('lootfilter_advanced_views_AdaptView.nothing_to_adapt_right_now')}</span>
              <span className="adv-s-muted">
                {facts ? tr('lootfilter_advanced_views_AdaptView.your_build_is_level_level', { level: facts.level }) : tr('lootfilter_advanced_views_AdaptView.no_build_is_open')}
                {play.summary.count ? tr('lootfilter_advanced_views_AdaptView.your_last_count_areas_were', { count: play.summary.count, minLevel: play.summary.minLevel, maxLevel: play.summary.maxLevel }) : noLog ? tr('lootfilter_advanced_views_AdaptView.and_the_game_log_client') : tr('lootfilter_advanced_views_AdaptView.and_no_areas_were_read')}
                {lf.prices ? tr('lootfilter_advanced_views_AdaptView.and_tolocalestring_poe_ninja_prices', { count: Object.keys(lf.prices.byName).length.toLocaleString() }) : '. Prices have not loaded.'}
              </span>
            </Panel>
          )}
          <Panel style={{ padding: '14px 16px', gap: 2 }}>
            <Eyebrow>{tr('lootfilter_advanced_views_AdaptView.earlier')}</Eyebrow>
            {history.length === 0 ? (
              <span className="adv-s-faint" style={{ paddingTop: 8 }}>{tr('lootfilter_advanced_views_AdaptView.nothing_applied_or_dismissed_yet')}</span>
            ) : (
              history.map((h, i) => (
                <div key={`${h.at}:${i}`} className="adv-s-hist">
                  <span style={{ color: h.k === 'Applied' ? 'var(--positive-text)' : 'var(--text-muted)' }}>{h.k === 'Applied' ? tr('h_lootB_Misc.applied') : tr('h_lootB_Adapt.dismissed')}</span>
                  <span style={{ color: 'var(--text-2)' }}>{h.t}</span>
                  <span className="adv-s-faint">{h.at > Date.now() - 45000 ? tr('lootfilter_advanced_views_AdaptView.just_now') : tr('lootfilter_advanced_views_AdaptView.at_ago', { value: ago(h.at) })}</span>
                </div>
              ))
            )}
          </Panel>
        </div>
        <Panel>
          <Eyebrow>{tr('lootfilter_advanced_views_AdaptView.watching')}</Eyebrow>
          {WATCH.map((w) => (
            <div key={w.key} className="adv-s-watch">
              <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 2 }}>
                <span className="adv-s-strong">{w.label}</span>
                <span className="adv-s-faint">{w.hint}</span>
              </div>
              <Switch checked={watching(w.key)} label={tr('lootfilter_advanced_views_AdaptView.toggle')} onChange={(v) => lf.setUi('adaptWatch', { ...watchState, [w.key]: v })} />
            </div>
          ))}
          <span className="adv-s-note">{tr('lootfilter_advanced_views_AdaptView.adapt_only_suggests_nothing_changes')}</span>
        </Panel>
      </div>
    </Page>
  );
}
