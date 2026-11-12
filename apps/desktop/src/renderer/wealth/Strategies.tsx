import { useState } from 'react';
import { fmtChaos, fmtPct, type StrategyView } from '../../shared/wealth.js';
import { Icon, Switch, useToast } from '../ui.js';
import { change, Chip, Empty, ItemIcon, Panel, Spark, Seg } from './wui.js';
import type { Wealth } from './useWealth.js';
import type { Cat } from '../../shared/wealth.js';
import { tr } from '../i18n';
import { fmtOld, item, strat } from './mainText';

const nm = (x: { name: string; mine?: boolean }): string => (x.mine ? item(x.name) : strat(x.name));
const DIFF: Record<string, string> = { Easy: 'var(--positive-text)', Medium: 'var(--warning-text)', Hard: 'var(--negative-text)' };

export function Strategies({ s }: { s: Wealth }) {
  const { w, ui, patch, go, strategies, now } = s;
  const toast = useToast();
  const [sort, setSort] = useState(0);
  if (!w) return null;
  const d = w.divine;
  const mine = w.mine;
  const all = ui.stTab === 2 ? mine : ui.stTab === 1 ? [...strategies, ...mine].filter((x) => w.favs[x.id]) : strategies;
  const list = sort === 1 ? [...all].sort((a, b) => b.net - a.net) : all;
  const priced = w.prices.fetchedAt ? tr('wealth_Strategies.priced_from_poe_ninja_fetchedat', { fetchedAt: fmtOld(now - w.prices.fetchedAt) }) : tr('wealth_Strategies.prices_not_loaded');

  const copyAtlas = async (x: StrategyView) => {
    try {
      await navigator.clipboard.writeText(`${x.name}\nAtlas picks:\n${x.atlas.map((a) => `- ${a.n}`).join('\n')}${x.atlasPoints ? `\n${x.atlasPoints}` : ''}`);
      toast({ text: tr('wealth_Strategies.atlas_picks_copied_as_a'), kind: 'ok' });
    } catch {
      toast({ text: tr('wealth_Strategies.could_not_reach_the_clipboard'), kind: 'error' });
    }
  };

  const copySetup = async (x: StrategyView) => {
    const txt = `${x.name}\nMap: ${x.map}\n` + [...x.scarabRows, ...x.deviceRows].map((r) => `${r.perMap}x ${r.name}`).join('\n');
    try {
      await navigator.clipboard.writeText(txt);
      toast({ text: tr('wealth_Strategies.setup_copied'), kind: 'ok' });
    } catch {
      toast({ text: tr('wealth_Strategies.could_not_reach_the_clipboard'), kind: 'error' });
    }
  };

  return (
    <div className="w-strat">
      <div className="w-st-h">
        <Seg labels={[tr('wealth_Strategies_2.curated'), tr('wealth_Strategies_2.favourites'), tr('wealth_Strategies_2.mine')]} active={ui.stTab} onPick={(i) => patch({ stTab: i as 0 | 1 | 2 })} label={tr('wealth_Strategies.strategy_list')} />
        <span className="w-sub-t">{priced}</span>
        <span className="w-st-sort">
          <span className="w-sub-t">{tr('wealth_Strategies.sort')}</span>
          <Seg labels={[tr('wealth_Strategies_2.listed_order'), tr('wealth_Strategies_2.highest_value_first')]} active={sort} onPick={setSort} label={tr('wealth_Strategies.sort_strategies')} />
        </span>
      </div>
      {ui.stTab === 0 && w.community.available && (
        <section className="w-panel w-comm" data-lg="panel" aria-label={tr('wealth_Strategies.community_index')}>
          <label className="w-comm-opt" title={`${tr('wealth_Strategies.sessions_shared_by_other_players')} ${tr('wealth_Strategies.share_anonymous_results_of_strategy_2')}`}>
            <Switch label={tr('wealth_Strategies.share_anonymous_results_of_strategy')} checked={w.community.share} onChange={(v) => void window.pom.wealth.setShareSessions(v)} />
            <span>{tr('wealth_Strategies.share_anonymous_results_of_strategy')}</span>
            <span className="faint" style={{ marginLeft: 'auto' }}>{w.sync.league || tr('wealth_Strategies.this_league')}</span>
          </label>
          {w.community.share && !w.community.signedIn && <span className="w-sub-t" role="status">{tr('wealth_Strategies.sign_in_to_path_of')}</span>}
        </section>
      )}
      {list.length === 0 && <Empty title={tr('wealth_Strategies.no_strategies_here')} body={ui.stTab === 2 ? tr('wealth_Strategies.publish_a_session_from_sessions') : ui.stTab === 1 ? tr('wealth_Strategies.star_a_strategy_to_keep') : tr('wealth_Strategies.no_strategies_match')} />}
      {list.map((x) => {
        const c = change(x.spark);
        const fav = !!w.favs[x.id];
        const hi = ui.strat === x.id;
        return (
          <article key={x.id} className="w-panel w-card-s" data-lg="panel" aria-label={nm(x)} data-hi={hi}>
            <div className="w-card-top" onClick={(e) => { if (!(e.target as HTMLElement).closest('button')) patch({ strat: hi ? null : x.id }); }}>
              <div className="w-card-id">
                <div className="w-tags">
                  {ui.stTab === 1 && <span className="w-chip gold cur" title={x.mine ? undefined : tr('wealth_Strategies.curated_setups_are_written_by')}><Icon name="crown" size={11} />{x.mine ? tr('wealth_Strategies.yours') : tr('wealth_Strategies.curated')}</span>}
                  {x.tags.filter((t) => t !== 'Mine').map((t) => <Chip key={t}>{strat(t)}</Chip>)}
                  {!x.mine && <span className="w-diff" style={{ color: DIFF[x.difficulty] }}><Icon name="gauge" size={12} />{strat(x.difficulty)}</span>}
                </div>
                <span className="w-card-name">{nm(x)}</span>
                <span className="w-card-by" title={strat(x.source)}>
                  {x.community?.verified ? (
                    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }} title={`${tr('wealth_Strategies.verified_from_count_sessions', { count: x.community.players })}. ${tr('wealth_Strategies.players_different_players_none_of', { players: x.community.players })}`}>
                      <Icon name="shield-check" size={12} style={{ color: 'var(--positive-text)' }} />{tr('wealth_Strategies.verified_players', { players: x.community.players })}
                    </span>
                  ) : (
                    <>
                      <Icon name="shield-check" size={12} style={{ color: x.basis === 'measured' ? 'var(--positive-text)' : 'var(--warning)' }} />{x.basis === 'measured' ? tr('wealth_Strategies.measured_from_count_sessions', { count: x.sessionsUsed }) : tr('wealth_Strategies.estimate_not_yet_verified_from', { n: x.community?.players ?? 0 })}
                      {x.basis === 'measured' && x.community && x.community.players > 0 && <span className="faint">{tr('wealth_Strategies.players_of_3_players_so', { players: x.community.players })}</span>}
                    </>
                  )}
                </span>
              </div>
              <div className="w-card-nums">
                <div><span className="w-eyebrow-t">{tr('wealth_Strategies.net_hour')}</span><b title={x.basis === 'measured' ? tr('wealth_Strategies.net_per_hour_worked_out') : tr('wealth_Strategies.net_per_hour_the_loot')}>{(x.net / d).toFixed(1)}<i>{tr('wealth_Strategies.div')}</i></b></div>
                {x.community?.verified && <div title={tr('wealth_Strategies.the_middle_result_of_the')}><span className="w-eyebrow-t">{tr('wealth_Strategies.players_median')}</span><b>{tr('wealth_Strategies.tofixed_div_h', { medianPerHour: x.community.medianPerHour.toFixed(1) })}</b></div>}
                <div><span className="w-eyebrow-t">{x.mine ? tr('wealth_Strategies.cost_hour') : tr('wealth_Strategies.cost_map')}</span><b>{x.mine ? fmtChaos(x.cost, d) : fmtChaos(x.costPerMap, d)}</b></div>
                <div><span className="w-eyebrow-t">{tr('wealth_Strategies.n7_days')}</span><b><Spark data={x.spark} w={72} h={22} /><i style={{ color: c >= 0 ? 'var(--positive-text)' : 'var(--negative-text)' }}>{x.mine ? '' : fmtPct(c)}</i></b></div>
                <button type="button" className={hi ? 'w-btn' : 'w-btn alt'} onClick={() => void window.pom.wealth.startSession(x.name, x.id).then(() => { go('overview'); toast({ text: tr('wealth_Strategies.session_started_tagged_name', { name: x.name }), kind: 'ok' }); })}>
                  <Icon name="play" size={14} />
                  {tr('wealth_Strategies.start_a_session')}
                </button>
                <button type="button" className="w-fav w-fav-open" aria-expanded={hi} aria-label={hi ? tr('wealth_Strategies.hide_details') : tr('wealth_Strategies.show_details')} title={hi ? tr('wealth_Strategies.hide_details') : tr('wealth_Strategies.show_details')} onClick={() => patch({ strat: hi ? null : x.id })}>
                  <Icon name={hi ? 'chevron-up' : 'chevron-down'} size={16} />
                </button>
                <button type="button" className="w-fav" aria-pressed={fav} aria-label={fav ? tr('wealth_Strategies.remove_from_favourites') : tr('wealth_Strategies.add_to_favourites')} title={fav ? tr('wealth_Strategies.remove_from_favourites') : tr('wealth_Strategies.add_to_favourites')} onClick={() => void window.pom.wealth.setFav(x.id, !fav)}>
                  <Icon name={fav ? 'star-fill' : 'star'} size={16} />
                </button>
              </div>
            </div>
            {hi && <div className="w-card-cols">
              {!x.mine && (
                <section>
                  <span className="w-eyebrow-t"><Icon name="layers" size={13} /> {tr('wealth_Strategies.scarabs_per_map')}</span>
                  <div className="w-ing w-ing-sc w-ing-h" aria-hidden="true"><span /><span /><span className="r">{tr('wealth_Strategies.have_col')}</span><span className="r">{tr('wealth_Strategies.per_map_cost_col')}</span></div>
                  {x.scarabRows.map((r) => (
                    <div key={r.name} className="w-ing w-ing-sc">
                      <ItemIcon name={r.art} cat="scar" {...(r.artCat ? { artCat: r.artCat } : {})} />
                      <span className="w-name" title={r.name}>{r.name}</span>
                      <span className="r" style={{ color: r.have >= r.perMap * 10 ? undefined : 'var(--warning-text)' }} title={`${tr('h_c_Wl2.you_have', { have: r.have })}${r.have >= r.perMap * 10 ? '' : ` · ${tr('h_c_Wl2.need_for_10', { n: Math.ceil(r.perMap * 10) })}`}`}>{tr('wealth_Strategies.have_n_of_m', { have: r.have, need: Math.ceil(r.perMap * 10) })}</span>
                      <span className="r">{r.unit === null ? <em className="w-np">{tr('wealth_Strategies.no_price')}</em> : `× ${r.perMap} · ${fmtChaos(r.unit * r.perMap, d)}`}</span>
                    </div>
                  ))}
                </section>
              )}
              {!x.mine && (
                <section>
                  <span className="w-eyebrow-t"><Icon name="map" size={13} /> {tr('wealth_Strategies.map_and_device')}</span>
                  <div className="w-ing">
                    <ItemIcon bare name="Strand Map (Tier 16)" cat="map" artCat="maps" />
                    <span className="w-name wrap" title={strat(x.mapNote)}>{strat(x.map)}<i>{strat(x.mapNote).split(/(?<=[.!?])\s/)[0]}</i></span>
                  </div>
                  {x.deviceRows.map((r) => (
                    <div key={r.name} className="w-ing">
                      <ItemIcon name={r.art} cat="cur" {...(r.artCat ? { artCat: r.artCat } : {})} />
                      <span className="w-name">{r.name}</span>
                      <span className="r">× {r.perMap}</span>
                      <span className="r">{r.unit === null ? <em className="w-np">{tr('wealth_Strategies.no_price')}</em> : fmtChaos(r.unit * r.perMap, d)}</span>
                    </div>
                  ))}
                </section>
              )}
              {!x.mine && x.atlas.length > 0 && (
                <section>
                  <span className="w-eyebrow-t"><Icon name="tree" size={13} /> {tr('wealth_Strategies.atlas')}</span>
                  <div className="w-atlas">
                    {x.atlas.map((a) => (
                      <span key={a.n}><Icon name={a.kind} size={12} />{strat(a.n)}</span>
                    ))}
                  </div>
                  {x.atlasPoints && <span className="w-sub-t">{x.atlasPoints}</span>}
                  <button type="button" className="w-btn alt sm" onClick={() => void copyAtlas(x)}>
                    <Icon name="copy" size={13} />
                    {tr('wealth_Strategies.copy_atlas_tree')}
                  </button>
                </section>
              )}
              <section className={x.mine ? 'wide' : ''}>
                <span className="w-eyebrow-t" title={x.basis === 'measured' ? tr('wealth_Strategies.measured_tofixed_maps_an_hour', { count: x.sessionsUsed, mapsPerHour: x.mapsPerHour.toFixed(1) }) : tr('wealth_Strategies.estimate_mapsperhour_maps_an_hour', { mapsPerHour: x.mapsPerHour })}><Icon name="coins" size={13} /> {tr('wealth_Strategies.where_the_money_comes_from')}</span>
                {x.lootRows.map((r) => {
                  const tot = x.lootRows.reduce((a, l) => a + l.perHour, 0) || 1;
                  return (
                    <div key={r.name} className="w-loot">
                      <div className="w-loot-h">
                        <ItemIcon name={r.art} cat={'cur' as Cat} {...(r.artCat ? { artCat: r.artCat } : {})} size={20} />
                        <span className="w-name">{r.name}</span>
                        <span className="r">{tr('wealth_Strategies.tofixed_div_h', { medianPerHour: (r.perHour / d).toFixed(1) })}</span>
                      </div>
                      <span className="w-loot-bar"><span style={{ width: `${Math.round((r.perHour / tot) * 100)}%` }} /></span>
                    </div>
                  );
                })}
                {x.unpriced.length > 0 && <span className="w-avoid"><Icon name="warning" size={13} />{tr('wealth_Strategies.no_price_for_join_left', { unpriced: x.unpriced.join(', ') })}</span>}
              </section>
            </div>}
            {hi && <div className="w-card-foot">
              <span className="w-note"><Icon name="message" size={14} /><span className="w-note-b">{strat(x.note)}{x.needs && <i> {tr('wealth_Strategies.needs_needs', { needs: strat(x.needs) })}</i>}{x.avoid && <span className="w-avoid"><Icon name="ban" size={13} />{strat(x.avoid)}</span>}</span></span>
              {x.yours && <span className="w-yours"><Icon name="timer" size={13} />{tr('wealth_Strategies.your_runs_tofixed_div_h', { value: (x.yours.perHour / d).toFixed(1), sessions: x.yours.sessions, sessions2: x.yours.sessions > 1 ? 's' : '' })}</span>}
              {!x.mine && (
                <button type="button" className="w-btn alt" onClick={() => (x.missing > 0 ? go('market', { mcat: 'scar', mq: '', mi: null }) : toast({ text: tr('wealth_Strategies.you_have_enough_for_10'), kind: 'ok' }))}>
                  <Icon name="bag" size={15} />
                  {x.missing > 0 ? tr('wealth_Strategies.buy_missing_v1', { value: fmtChaos(x.missing, d) }) : tr('wealth_Strategies.you_have_everything_for_10')}
                </button>
              )}
              {!x.mine && (
                <button type="button" className="w-btn alt" onClick={() => void copySetup(x)}>
                  <Icon name="clipboard" size={15} />
                  {tr('wealth_Strategies.copy_setup')}
                </button>
              )}
            </div>}
          </article>
        );
      })}
    </div>
  );
}
