import { useMemo, useState, type ReactNode } from 'react';
import type { CatalogItem } from '../../../shared/lootfilter/catalog.js';
import { GUIDED_SECTIONS, VERB, clauseLabel, guidedRest, selectItems, sectionOfType, tiersOfSection } from '../../../shared/lootfilter/guided.js';
import type { Clause, LabelStyle, Rule } from '../../../shared/lootfilter/types.js';
import { Icon } from '../../ui';
import { useSay } from './say';
import { artFor } from '../../gameArt';
import { useLf } from '../lfStore';
import { priceAge } from '../hidesText';
import { useBuildRules } from '../buildRulesHook';
import { usePlay } from '../usePlay';
import { LabelChip } from '../LabelChip';
import { ItemChip } from '../ItemChip';
import { GROUND_DESERT } from '../LabelChip';
import { W0 } from './model';
import { ruleKind } from './ruleKind';
import { ChipPop } from './ChipPop';
import type { GuidedApi } from './Guided';
import { tr } from '../../i18n';
import { lfText } from '../mainText';
import { gsecName } from '../names';
import { plural } from '../advanced/views/plural';

const AIC: Record<string, string> = { hide: 'eye-off', quiet: 'volume-off', standout: 'sparkle-fill', loud: 'volume', reset: 'reset', custom: 'palette', match: 'palette' };

/** Board first: the board is what the player came for; "Your changes" is a rail beside it (under it on a narrow area). */
export function Home({ api, resume, dismissResume, continueResume }: { api: GuidedApi; resume: boolean; dismissResume: () => void; continueResume: () => void }) {
  const lf = useLf();
  const toast = useSay();
  const cat = lf.catalog;
  const br = useBuildRules();
  const play = usePlay();
  const onbMap = (lf.ui.guidedOnb ?? {}) as Record<string, boolean>;
  const onb = !onbMap[lf.doc.id];
  const [only, setOnly] = useState<'all' | 'mine'>('all');
  const [showHidden, setShowHidden] = useState(true);
  const dismissed = (Array.isArray(lf.ui.guidedSuggDismissed) ? lf.ui.guidedSuggDismissed : []) as string[];
  const sugg = lf.doc.written || lf.doc.rules.length ? play.suggestions.find((x) => !dismissed.includes(x.id)) : undefined;

  const mine = useMemo(() => lf.doc.rules.filter((r) => r.source !== 'build').sort((a, b) => a.priority - b.priority), [lf.doc.rules]);
  const mineIds = new Set(mine.map((r) => r.id));
  /** Changed by the player: a rule of their own touches it (rules that came from the build do not count). */
  const byMe = (i: CatalogItem): boolean => !!lf.evaluateCatalogItem(i)?.matched.some((b) => b.ruleId && mineIds.has(b.ruleId));
  const itemsOf = (r: Rule): CatalogItem[] => (cat && r.guided ? selectItems(cat, r.guided.sel, r.guided.exc) : []);

  // One entry per change. The rules a Re-tier or an Adapt wrote together are one entry that opens to show them.
  const [openBatch, setOpenBatch] = useState<Record<string, boolean>>({});
  const entries = useMemo(() => {
    const out: { rules: Rule[]; batch?: { id: string; name: string } }[] = [];
    const at = new Map<string, number>();
    for (const r of mine) {
      if (r.batch) {
        const k = at.get(r.batch.id);
        if (k !== undefined) {
          out[k]!.rules.push(r);
          continue;
        }
        at.set(r.batch.id, out.length);
        out.push({ rules: [r], batch: r.batch });
      } else out.push({ rules: [r] });
    }
    return out;
  }, [mine]);
  const rows = entries.map((e, ix) => {
    const r = e.rules[0]!;
    const g = r.guided;
    const items = itemsOf(r);
    const gearBases = g && lf.engineBases?.available ? g.sel.filter((c) => c.t === 'gear').length : 0;
    return { r, ix, items, gearBases, group: e.batch ? e.rules : undefined, batch: e.batch };
  });

  const move = (ix: number, d: number): void => {
    const j = ix + d;
    if (j < 0 || j >= entries.length) return;
    // Swap the two entries and hand the existing priorities out again in the new order.
    const order = entries.map((e) => e.rules);
    [order[ix], order[j]] = [order[j]!, order[ix]!];
    const flat = order.flat();
    const prios = mine.map((x) => x.priority).sort((a, b) => a - b);
    const next = new Map(flat.map((x, k) => [x.id, prios[k]!] as const));
    lf.edit(tr('lootfilter_guided_Home.moved_to_position_v1', { value: j + 1 }), (doc) => ({ ...doc, rules: doc.rules.map((x) => (next.has(x.id) ? { ...x, priority: next.get(x.id)! } : x)) }));
    toast({ text: tr('lootfilter_guided_Home.moved_to_position_v1_later', { value: j + 1 }), kind: 'ok', ttl: 2500 });
  };
  const removeBatch = (rs: Rule[]): void => {
    const ids = new Set(rs.map((x) => x.id));
    lf.setRules(tr('lootfilter_guided_Home_2.deleted_a_change'), (all) => all.filter((x) => !ids.has(x.id)));
    toast({ text: tr('lootfilter_guided_Home.change_deleted'), kind: 'ok', ttl: 8000, action: { label: tr('lootfilter_guided_Home.undo'), run: () => lf.undo() } });
  };
  const toggleBatch = (rs: Rule[], on: boolean): void => {
    const ids = new Set(rs.map((x) => x.id));
    lf.setRules(on ? tr('lootfilter_guided_Home.turned_a_change_on') : tr('lootfilter_guided_Home.turned_a_change_off'), (all) => all.map((x) => (ids.has(x.id) ? { ...x, enabled: on } : x)));
    toast({ text: on ? tr('lootfilter_guided_Home.change_turned_on') : tr('lootfilter_guided_Home.change_turned_off'), kind: 'ok', ttl: 2500 });
  };

  const removeRule = (r: Rule): void => {
    lf.removeRule(r.id, tr('lootfilter_guided_Home_2.deleted_a_change'));
    toast({ text: tr('lootfilter_guided_Home.change_deleted'), kind: 'ok', ttl: 8000, action: { label: tr('lootfilter_guided_Home.undo'), run: () => lf.undo() } });
  };
  const editRule = (r: Rule): void => {
    const g = r.guided;
    if (g) api.openWizard({ sel: g.sel, exc: g.exc, act: g.act, look: g.look ?? null, match: g.match ?? null, editId: r.id }, 2);
    else api.nav.openAdvanced('customize', { ruleId: r.id });
  };

  const base = `NeverSink ${lf.baseVersion}`;
  const pricesLine: ReactNode = lf.prices ? (
    `Prices: ${lf.prices.league}, ${priceAge(lf.prices.fetchedAt)}${lf.priceStale ? ' (offline, old)' : ''}.`
  ) : lf.pricesLoading ? (
    tr('lootfilter_guided_Home.prices_loading')
  ) : (
    <>
      {tr('lootfilter_guided_Home.prices_not_loaded_v2', { value: ' ' })}
      <button type="button" className="gd-link" title={lf.priceError ?? tr('lootfilter_guided_Home.try_poe_ninja_again')} onClick={() => void lf.refreshPrices(true)}>
        {tr('lootfilter_guided_Home.retry')}
      </button>
    </>
  );
  const buildOn = !!lf.doc.setup.build?.on;

  const moveCell = (ix: number) => (
    <span className="gd-move">
      <span className="gd-pos" title={tr('lootfilter_guided_Home.position_later_changes_win')}>{ix + 1}</span>
      <span className="gd-movebtns">
        <button type="button" className="gd-iconbtn" aria-label={tr('lootfilter_guided_Home.move_up')} title={tr('lootfilter_guided_Home.move_up')} aria-disabled={ix === 0} onClick={() => move(ix, -1)}>
          <Icon name="chevron-up" size={14} />
        </button>
        <button type="button" className="gd-iconbtn" aria-label={tr('lootfilter_guided_Home.move_down')} title={tr('lootfilter_guided_Home.move_down')} aria-disabled={ix === entries.length - 1} onClick={() => move(ix, 1)}>
          <Icon name="chevron-down" size={14} />
        </button>
      </span>
    </span>
  );

  // The chip popover: one open at a time, held in the shared pop state so Esc and clicks elsewhere close it.
  const chipKey = (k: string): string => `chip:${k}`;
  const chip = (key: string, node: ReactNode, pop: { name: string; sel: Clause[]; look: LabelStyle; hidden: boolean; pick: string }): ReactNode => (
    <span key={key} className="gd-chipwrap">
      {node}
      {api.pop === chipKey(key) && (
        <ChipPop
          name={pop.name}
          sel={pop.sel}
          look={pop.look}
          hidden={pop.hidden}
          onClose={() => api.setPop(null)}
          onMore={() => api.openWizard({ sel: pop.sel, pick: pop.pick }, 2)}
        />
      )}
    </span>
  );
  const openChip = (key: string): void => api.setPop(api.pop === chipKey(key) ? null : chipKey(key));

  return (
    <div className="gd-col gd-home" data-screen-label="Loot Filter / Guided / Home">
      {resume ? (
        <div className="gd-banner" role="status">
          <Icon name="history" size={18} style={{ color: 'rgb(var(--area-filter-rgb))' }} />
          <span style={{ flex: 1, color: 'var(--text-strong)' }}>{tr('lootfilter_guided_Home.you_were_in_the_middle')}</span>
          <button className="gd-secondary" onClick={dismissResume}>
            {tr('lootfilter_guided_Home.discard')}
          </button>
          <button className="gd-secondary" onClick={continueResume}>
            {tr('lootfilter_guided_Home.continue')}
          </button>
        </div>
      ) : sugg ? (
        <div className="gd-sugg" role="status">
          <span className="ic">
            <Icon name="sparkle-fill" size={16} />
          </span>
          <span className="tx">
            <span style={{ color: 'var(--text-strong)', fontSize: 14 }}>{lfText(sugg.title)}</span>
            <span style={{ color: 'var(--text-muted)', fontSize: 12.5 }}>{lfText(sugg.text)}</span>
          </span>
          <button className="gd-ghost" onClick={() => lf.setUi('guidedSuggDismissed', [...dismissed, sugg.id])}>
            <Icon name="x" size={14} />
            {tr('lootfilter_guided_Home.dismiss')}
          </button>
          <button className="gd-secondary sm" onClick={() => api.setPop('strict')}>
            <Icon name="eye" size={14} />
            {tr('lootfilter_guided_Home.review')}
          </button>
        </div>
      ) : null}

      <div className="gd-homehead">
        <div style={{ flex: 1, minWidth: 0 }}>
          <h1 className="gd-h1">{tr('lootfilter_guided_Home.your_loot_filter')}</h1>
          <p className="gd-sub gd-subline">
            {mine.length ? tr('lootfilter_guided_Home.count_changes_on_top_of', { count: entries.length, base }) : tr('lootfilter_guided_Home.base_ready_to_use', { base })} {pricesLine}
          </p>
        </div>
        <button className="gd-secondary" onClick={() => api.openWizard({}, 1)}>
          <Icon name="wand" size={16} />
          {tr('lootfilter_guided_Home.change_something')}
        </button>
        {lf.build && lf.build.info.valid && (
          <button className="gd-secondary" onClick={() => api.nav.openAdvanced('build')}>
            <Icon name="tree" size={16} />
            {buildOn ? tr('lootfilter_guided_Home.edit_the_filter_for_name', { name: lf.build.name }) : tr('lootfilter_guided_Home.build_filter_for_name', { name: lf.build.name })}
          </button>
        )}
      </div>

      {onb && (
        <div className="gd-onb" role="note" aria-label={tr('lootfilter_guided_Home.how_this_works')}>
          <Icon name="lightbulb" size={16} style={{ color: 'var(--text-muted)', flex: 'none' }} />
          <span style={{ flex: 1, minWidth: 0 }}>{tr('lootfilter_guided_Home.click_any_item_to_change')}</span>
          <button className="gd-iconbtn" aria-label={tr('lootfilter_guided_Home.dismiss')} title={tr('lootfilter_guided_Home.dismiss')} onClick={() => lf.setUi('guidedOnb', { ...onbMap, [lf.doc.id]: true })}>
            <Icon name="x" size={14} />
          </button>
        </div>
      )}

      <div className="gd-homegrid">
        <section className="gd-card gd-board" aria-label={tr('lootfilter_guided_Home.how_it_looks_in_game')}>
          <div className="gd-boardhd">
            <h3>{tr('lootfilter_guided_Home.how_it_looks_in_game')}</h3>
            <div className="gd-legend lf-faint" aria-label={tr('lootfilter_guided_Home.legend')}>
              <span><s>{tr('lootfilter_guided_Home.name')}</s> {tr('lootfilter_guided_Home.hidden')}</span>
              <span><Icon name="volume-low" size={12} /> {tr('lootfilter_guided_Home.sound')}</span>
              <span><Icon name="flare" size={12} /> {tr('lootfilter_guided_Home.beam')}</span>
              <span><span className="gd-legdot" /> {tr('lootfilter_guided_Home.changed_by_you')}</span>
            </div>
            <span className="sp" />
            <div className="gd-seg" role="group" aria-label={tr('lootfilter_guided_Home.show')}>
              {[['all', tr('lootfilter_guided_Home_2.all_items')], ['mine', tr('lootfilter_guided_Home_2.only_my_changes')]].map(([k, l]) => (
                <button key={k} role="radio" aria-checked={only === k} aria-pressed={only === k} onClick={() => setOnly(k as 'all' | 'mine')}>
                  {l}
                </button>
              ))}
            </div>
            <label className="gd-swlabel">
              <button className="gd-switch" role="switch" aria-checked={showHidden} aria-label={tr('lootfilter_guided_Home.show_hidden_items')} onClick={() => setShowHidden(!showHidden)} />
              {tr('lootfilter_guided_Home.show_hidden_items')}
            </label>
          </div>
          {!cat ? (
            <div className="lf-muted gd-boardwait">{tr('lootfilter_guided_Home.reading_neversink_baseversion', { baseVersion: lf.baseVersion })}</div>
          ) : (
            <div className="gd-boardrows" style={{ background: GROUND_DESERT }}>
              {GUIDED_SECTIONS.map((sec) => {
                const art = artFor(sec.art);
                const row = (chips: ReactNode): ReactNode => (
                  <div key={sec.id} className="gd-secrow" data-section={sec.id}>
                    <div className="gd-secname">
                      {art && <img src={art} alt="" className="gd-art" />}
                      <span>{gsecName(sec)}</span>
                    </div>
                    <div className="gd-secchips">{chips}</div>
                  </div>
                );
                if (sec.id === 'gear') {
                  // The gear the followed build wears, as the filter would show it on the ground.
                  const worn = lf.doc.setup.followBuild ? br.facts?.items ?? [] : [];
                  if (!worn.length || only === 'mine') return null;
                  const chips = worn.map((it) => {
                    const r = lf.evaluate({ name: it.base, rarity: it.rarity === 'UNIQUE' ? 'Unique' : it.rarity === 'RARE' ? 'Rare' : it.rarity === 'MAGIC' ? 'Magic' : 'Normal', itemLevel: it.itemLevel ?? 83, areaLevel: 83 });
                    const hidden = r ? !r.visible : false;
                    if (hidden && !showHidden) return null;
                    const st = r?.style;
                    // Like every other chip, a gear chip opens the change popover; its change is for that base type.
                    const key = `gear:${it.slot}:${it.base}`;
                    return st
                      ? chip(
                          key,
                          <LabelChip name={it.base} style={st} hidden={hidden} hiddenLook="dashed" scale={0.5} fxInside onClick={() => openChip(key)} title={`${it.base}${hidden ? ' (hidden)' : ''}. Click to change`} />,
                          { name: it.base, sel: [{ t: 'item', name: it.base }], look: st, hidden, pick: 'gear' },
                        )
                      : null;
                  });
                  return row(chips);
                }
                const items = cat.items.filter((i) => sectionOfType(i.type)?.id === sec.id);
                const tiers = tiersOfSection(cat, sec);
                if (!items.length && !tiers.length) return null;
                const priceOf = (i: CatalogItem): number => lf.prices?.byName[i.name]?.chaos ?? lf.prices?.uniqueByBase[i.name] ?? -1;
                const isHidden = (i: CatalogItem): boolean => lf.evaluateCatalogItem(i)?.visible === false;
                const byPrice = [...items].sort((a, b) => priceOf(b) - priceOf(a));
                // A short board: the dearest items that show, a few of the dearest that are hidden, and everything you changed.
                const changed = byPrice.filter(byMe);
                let list: CatalogItem[];
                if (only === 'mine') list = changed;
                else {
                  const seen = new Set<string>();
                  const pick = (xs: CatalogItem[], n: number): void => {
                    let k = 0;
                    for (const x of xs) {
                      if (k >= n) break;
                      if (!seen.has(x.name)) {
                        seen.add(x.name);
                        k++;
                      }
                    }
                  };
                  pick(changed, 40);
                  pick(byPrice.filter((i) => !isHidden(i)), 12);
                  if (showHidden) pick(byPrice.filter(isHidden), 3);
                  list = byPrice.filter((i) => seen.has(i.name));
                }
                if (!showHidden) list = list.filter((i) => !isHidden(i));
                if (only === 'mine' && !list.length) return null;
                return row(
                  items.length
                    ? list.map((i) => {
                        const ev = lf.evaluateCatalogItem(i);
                        return chip(
                          i.name,
                          <ItemChip item={i} hidTag={undefined} scale={0.5} hiddenLook="dashed" fxInside bright={false} changed={byMe(i)} onClick={() => openChip(i.name)} title={`${i.name}${isHidden(i) ? ' (hidden)' : ''}${byMe(i) ? ' · changed by you' : ''}. Click to change${sec.id === 'uniques' ? '. The price is the dearest unique on this base' : ''}`} />,
                          { name: i.name, sel: [{ t: 'item', name: i.name }], look: ev?.style ?? i.style, hidden: ev ? !ev.visible : i.hidden, pick: sec.id },
                        );
                      })
                    : tiers.map((t) =>
                        chip(
                          t.key,
                          <LabelChip name={t.label} style={t.style} hidden={t.kind === 'Hide'} hiddenLook="dashed" scale={0.5} fxInside onClick={() => openChip(t.key)} title={tr('lootfilter_guided_Home.name_label_click_to_change', { name: sec.name, label: t.label })} />,
                          { name: `${gsecName(sec)} ${t.label}`, sel: [{ t: 'tier', type: t.type, tier: t.tier }], look: t.style, hidden: t.kind === 'Hide', pick: sec.id },
                        ),
                      ),
                );
              })}
            </div>
          )}
        </section>

        <section className="gd-card gd-rail" aria-label={tr('lootfilter_guided_Home.your_changes')}>
          <div className="gd-railhd">
            <h3>{tr('lootfilter_guided_Home.your_changes')}</h3>
            <span className="gd-count" aria-label={tr('lootfilter_guided_Home.length_changes', { count: entries.length })}>{entries.length}</span>
          </div>
          {entries.length > 1 && <div className="hint gd-railhint">{tr('lootfilter_guided_Home.they_run_in_order_when')}</div>}
          {!entries.length && (
            <div className="gd-railempty">
              <b>{tr('lootfilter_guided_Home.no_changes_yet')}</b>
              <span>{tr('lootfilter_guided_Home.click_any_item_on_the')}</span>
            </div>
          )}
          <div className="gd-raillist">
            {rows.map(({ r, ix, items, gearBases, group, batch }) => {
              const g = r.guided;
              const text = g ? guidedRest(g, cat) : r.name ?? tr('lootfilter_guided_Home.advanced_rule');
              const n = items.length;
              if (group && batch) {
                const open = !!openBatch[batch.id];
                const on = group.some((x) => x.enabled);
                return (
                  <div key={batch.id} data-off={!on}>
                    <div className="gd-row" role="group" aria-label={tr('lootfilter_guided_Home.change_ix', { ix: ix + 1 })} data-off={!on}>
                      {moveCell(ix)}
                      <span className="gd-badge" title={tr('lootfilter_guided_Home.moved_to_new_tiers_by')}>
                        <Icon name="compare" size={15} />
                      </span>
                      <div className="txt" onClick={() => setOpenBatch((o) => ({ ...o, [batch.id]: !open }))}>
                        <div className="gd-rowtitle">
                          {batch.name}
                          {!on && <span className="gd-offpill">{tr('lootfilter_guided_Home.off')}</span>}
                        </div>
                        <div className="gd-rowsub">
                          {plural(group.length, 'item type')} · {on ? tr('lootfilter_guided_Home.on') : tr('lootfilter_guided_Home.off_2')}
                          {ix === entries.length - 1 && entries.length > 1 ? tr('lootfilter_guided_Home.newest') : ''}
                        </div>
                      </div>
                      <div className="gd-rowctl">
                        <button className="gd-switch" role="switch" aria-checked={on} aria-label={on ? tr('lootfilter_guided_Home.turn_off') : tr('lootfilter_guided_Home.turn_on')} title={on ? tr('lootfilter_guided_Home.turn_off') : tr('lootfilter_guided_Home.turn_on')} onClick={() => toggleBatch(group, !on)} />
                        <button className="gd-iconbtn" aria-expanded={open} aria-label={open ? tr('lootfilter_guided_Home.hide_the_length', { count: group.length }) : tr('lootfilter_guided_Home.show_the_length', { count: group.length })} title={open ? tr('lootfilter_guided_Home.hide_them') : tr('lootfilter_guided_Home.show_the_length', { count: group.length })} onClick={() => setOpenBatch((o) => ({ ...o, [batch.id]: !open }))}>
                          <Icon name={open ? 'chevron-up' : 'chevron-down'} size={15} />
                        </button>
                        <button className="gd-iconbtn" aria-label={tr('lootfilter_guided_Home.delete_this_change')} title={tr('lootfilter_guided_Home.delete_this_change')} onClick={() => removeBatch(group)}>
                          <Icon name="trash" size={15} />
                        </button>
                      </div>
                    </div>
                    {open && (
                      <div className="gd-batchlist">
                        {group.map((x) => {
                          const name = x.targets[0]?.conditions?.find((c) => c.key === 'BaseType')?.values[0] ?? x.name ?? 'Item';
                          const it = cat?.byName.get(name);
                          const to = (x.name ?? '').replace(/^Price: .* to /, '');
                          return (
                            <div key={x.id} className="gd-batchrow">
                              <span style={{ flex: 'none', padding: '3px 6px', borderRadius: 6, background: GROUND_DESERT, display: 'inline-flex' }}>
                                <LabelChip name={name} style={it ? it.style : {}} scale={0.42} fxInside />
                              </span>
                              <span className="lf-muted" title={x.why}>
                                {it ? `${sectionOfType(it.type)?.name ?? it.type} · ` : ''}{tr('lootfilter_guided_Home.to_to', { to })}
                              </span>
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </div>
                );
              }
              return (
                <div className="gd-row" key={r.id} data-off={!r.enabled} role="group" aria-label={tr('lootfilter_guided_Home.change_ix', { ix: ix + 1 })}>
                  {moveCell(ix)}
                  <span className="gd-badge" title={g ? VERB[g.act] : tr('lootfilter_guided_Home.advanced_rule')}>
                    <Icon name={AIC[g?.act ?? 'custom'] ?? 'palette'} size={15} />
                  </span>
                  <div className="txt" onClick={() => editRule(r)}>
                    <div className="gd-rowtitle">
                      {g ? VERB[g.act] : r.source === 'price' ? tr('lootfilter_guided_Home.retier') : tr('lootfilter_guided_Home.rule')} {text}
                      {!r.enabled && <span className="gd-offpill">{tr('lootfilter_guided_Home.off')}</span>}
                    </div>
                    <div className="gd-rowsub">
                      {n ? tr('lootfilter_guided_Home.count_item_types', { count: n }) : gearBases ? tr('lootfilter_guided_Home.gear_rule') : g ? tr('lootfilter_guided_Home.tiers_and_gear') : `${ruleKind(r, cat)} · ${r.source}`}
                      {' · '}
                      {r.enabled ? tr('lootfilter_guided_Home.on') : tr('lootfilter_guided_Home.off_2')}
                      {ix === entries.length - 1 && entries.length > 1 ? tr('lootfilter_guided_Home.newest') : ''}
                    </div>
                  </div>
                  <div className="gd-rowctl">
                    <button className="gd-switch" role="switch" aria-checked={r.enabled} aria-label={r.enabled ? tr('lootfilter_guided_Home.turn_off') : tr('lootfilter_guided_Home.turn_on')} title={r.enabled ? tr('lootfilter_guided_Home.turn_off') : tr('lootfilter_guided_Home.turn_on')} onClick={() => { lf.updateRule(r.id, { enabled: !r.enabled }, r.enabled ? tr('lootfilter_guided_Home.turned_a_change_off') : tr('lootfilter_guided_Home.turned_a_change_on')); toast({ text: r.enabled ? tr('lootfilter_guided_Home.change_turned_off') : tr('lootfilter_guided_Home.change_turned_on'), kind: 'ok', ttl: 2500 }); }} />
                    <button className="gd-iconbtn" aria-label={tr('lootfilter_guided_Home.edit_this_change')} title={tr('lootfilter_guided_Home.edit')} onClick={() => editRule(r)}>
                      <Icon name="edit" size={15} />
                    </button>
                    <button className="gd-iconbtn" aria-label={tr('lootfilter_guided_Home.delete_this_change')} title={tr('lootfilter_guided_Home.delete_this_change')} onClick={() => removeRule(r)}>
                      <Icon name="trash" size={15} />
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        </section>
      </div>
    </div>
  );
}

export { W0, clauseLabel };
