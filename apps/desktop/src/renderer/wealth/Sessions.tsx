import { useEffect, useState } from 'react';
import { compareSession, fmtHM, fmtSigned, type CompareLine, type SessionItem, type SessionView, type StrategyView } from '../../shared/wealth.js';
import { Icon, useToast } from '../ui.js';
import { ActionMenu } from '../menu.js';
import { Chip, dayLabel, clock, Eyebrow, ItemIcon, Modal, Panel } from './wui.js';
import type { Wealth } from './useWealth.js';
import { tr } from '../i18n';
import { item, msg, sessName, strat } from './mainText';

const stratName = (x: { name: string; mine?: boolean }): string => (x.mine ? item(x.name) : strat(x.name));

export function Sessions({ s }: { s: Wealth }) {
  const { w, ui, patch, go, fmt, now } = s;
  const toast = useToast();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [cmp, setCmp] = useState(false);
  if (!w) return null;
  const list = w.sessions;
  const cur: SessionView | undefined = list.find((x) => x.id === ui.sess) ?? list[0];
  useEffect(() => { setEditing(false); setCmp(false); }, [cur?.id]);

  if (list.length === 0) {
    return (
      <div className="w-center">
        <Panel className="w-card">
          <div className="w-later">
            <Icon name="timer" size={28} />
            <b>{tr('wealth_Sessions.no_sessions_yet')}</b>
            <span>{tr('wealth_Sessions.sessions_start_on_their_own')}</span>
            <button type="button" className="w-btn" onClick={() => void window.pom.wealth.startSession('Session')}>
              <Icon name="plus" size={14} />
              {tr('wealth_Sessions.start_one_now')}
            </button>
          </div>
        </Panel>
      </div>
    );
  }
  const c = cur!;
  const maxBar = Math.max(1, ...c.bars.map((b) => Math.abs(b.v)));

  const rename = () => {
    const n = draft.trim();
    setEditing(false);
    if (n && n !== c.name) void window.pom.wealth.renameSession(c.id, n);
  };

  const rows = (items: SessionItem[], spent: boolean) =>
    items.map((r) => (
      <div key={r.key} className="w-tr w-srow" data-transfer={r.transfer ? '1' : undefined}>
        <ItemIcon name={r.art} cat={r.cat} {...(r.artCat ? { artCat: r.artCat } : {})} />
        <span className="w-name">{r.name}</span>
        <span className="r" style={{ color: spent ? 'var(--negative-text)' : 'var(--positive-text)' }}>{`${spent ? '−' : '+'}${r.qty.toLocaleString()}`}</span>
        <span className="r">{r.value > 0 ? fmt(r.value) : '—'}</span>
        <button type="button" className="w-link w-xfer" data-on={r.transfer ? '1' : undefined} title={r.transfer ? tr('wealth_Sessions.count_this_again') : tr('wealth_Sessions.moved_to_another_tab_mark')} onClick={() => void window.pom.wealth.markTransfer(c.id, r.key, !r.transfer)}>
          {r.transfer ? tr('wealth_Sessions.transfer') : '⇄'}
        </button>
      </div>
    ));

  return (
    <div className="w-sess">
      <Panel className="w-list">
        <div className="w-eyebrow">
          <span>{tr('wealth_Sessions.sessions_automatic')}</span>
        </div>
        <div className="w-rail-list">
          {list.map((x) => (
            <button key={x.id} type="button" className="w-srow-l" data-on={x.id === c.id} onClick={() => patch({ sess: x.id })}>
              <ItemIcon bare name={x.icon.name} cat={x.icon.cat} {...(x.icon.artCat ? { artCat: x.icon.artCat } : {})} size={30} />
              <span className="w-name">
                <span className="w-srow-n">{x.running && <i className="w-live sm" />}{sessName(x)}</span>
                <i>{`${dayLabel(x.start, now)} · ${fmtHM(x.minutes)}`}</i>
              </span>
              <span className="r" style={{ color: x.net >= 0 ? 'var(--positive-text)' : 'var(--negative-text)' }}>
                {fmtSigned(x.net, w.divine)}
                <i>{x.revenue > 0 || x.net !== 0 ? tr('wealth_Sessions.tofixed_div_h', { value: (x.perHour / w.divine).toFixed(1) }) : '—'}</i>
              </span>
            </button>
          ))}
        </div>
      </Panel>
      <div className="w-sess-r">
        <Panel>
          <div className="w-sess-h">
            <span className="w-sess-t">
              {editing ? (
                <input autoFocus value={draft} onChange={(e) => setDraft(e.target.value)} onBlur={rename} onKeyDown={(e) => (e.key === 'Enter' ? rename() : e.key === 'Escape' && setEditing(false))} aria-label={tr('wealth_Sessions.session_name')} />
              ) : (
                <span className="w-sess-name">
                  <b title={tr('wealth_Sessions.double_click_to_rename')} onDoubleClick={() => { setDraft(c.name); setEditing(true); }}>{sessName(c)}</b>
                </span>
              )}
              <i>{`${dayLabel(c.start, now)} – ${c.running ? 'now' : clock(c.end)}`}</i>
            </span>
            <span className="w-btns inline">
              <button
                type="button"
                className="w-btn sm"
                disabled={c.running}
                title={c.running ? tr('wealth_Sessions.end_the_session_first') : undefined}
                onClick={() => (c.published ? go('strategies', { stTab: 2, strat: `m${c.id}` }) : void window.pom.wealth.publishSession(c.id).then(() => toast({ text: tr('wealth_Sessions.saved_to_strategies_under_mine'), kind: 'ok' })))}
              >
                {c.published ? tr('wealth_Sessions.published') : tr('wealth_Sessions.publish_as_strategy')}
              </button>
              <ActionMenu
                title={tr('wealth_Sessions.more')}
                className="w-btn alt sm"
                trigger={<Icon name="more" size={14} />}
                actions={[
                  { label: tr('wealth_Sessions.compare_with_a_strategy'), icon: 'compare', run: () => setCmp(true) },
                  { label: tr('wealth_Sessions.delete'), icon: 'trash', run: () => void window.pom.wealth.deleteSession(c.id).then(() => toast({ text: tr('wealth_Sessions.session_deleted'), kind: 'ok', ttl: 12_000, action: { label: tr('wealth_Sessions.undo'), run: () => void window.pom.wealth.restoreSession(c.id).then((ok) => !ok && toast({ text: tr('wealth_Sessions.that_session_cannot_be_put'), kind: 'error' })) } })) },
                ]}
              />
            </span>
          </div>
          <div className="w-tiles">
            <Tile k="DURATION" v={fmtHM(c.minutes)} />
            <Tile k="REVENUE" v={fmt(c.revenue)} />
            <Tile k="COST" v={fmt(c.cost)} />
            <Tile k="NET" v={fmtSigned(c.net, w.divine)} tone={c.net >= 0 ? 'pos' : 'neg'} />
            <Tile k="PER HOUR" v={tr('wealth_Sessions.tofixed_div', { value: (c.perHour / w.divine).toFixed(1) })} />
            <span className="w-run-sub faint" style={{ gridColumn: '1 / -1' }}>{`${c.mapsUsed ? tr(c.mapsUsed === 1 ? 'h_c_Ws.maps_used_one' : 'h_c_Ws.maps_used_other', { n: c.mapsUsed }) + ' · ' : ''}${tr(c.snapshots === 1 ? 'h_c_Ws.snapshot_one' : 'h_c_Ws.snapshot_other', { n: c.snapshots })}`}</span>
          </div>
          <div className="w-pad">
            <span className="w-eyebrow-t">{tr('wealth_Sessions.value_added_per_snapshot')}</span>
            <div className="w-bars">
              {c.bars.length === 0 && <span className="w-none">{tr('wealth_Sessions.no_snapshots_inside_this_session')}</span>}
              {c.bars.map((b, i) => (
                <span key={i} title={`${clock(b.t)}: ${b.v >= 0 ? '+' : '−'}${fmt(Math.abs(b.v))}`} style={{ height: `${Math.max(8, (Math.abs(b.v) / maxBar) * 100)}%`, background: b.v > 1 ? 'var(--positive)' : b.v < -1 ? 'var(--negative)' : 'rgba(var(--line-rgb),.25)' }} />
              ))}
            </div>
          </div>
          {c.flags.length > 0 && (
            <div className="w-flags">
              {c.flags.map((f) => (
                <div key={f} className="w-flag">
                  <Chip tone={f.startsWith('Trade') ? 'neutral' : 'warning'}>{f.startsWith('Trade') ? tr('wealth_Sessions.trade') : tr('wealth_Sessions.check_this')}</Chip>
                  <span>{msg(f.replace(/^(Trade|Check this): /, ''))}</span>
                </div>
              ))}
            </div>
          )}
        </Panel>
        <div className="w-two">
          <Panel>
            <Eyebrow>{tr('wealth_Sessions.gained')}</Eyebrow>
            <div className="w-th w-srow"><span /><span>{tr('wealth_Sessions.item')}</span><span className="r">{tr('wealth_Sessions.qty')}</span><span className="r">{tr('wealth_Sessions.value')}</span><span /></div>
            <div className="w-rows">
              {rows(c.gained, false)}
              {c.gained.length === 0 && <div className="w-none">{tr('wealth_Sessions.nothing_arrived_yet')}</div>}
            </div>
          </Panel>
          <Panel>
            <Eyebrow>{tr('wealth_Sessions.spent')}</Eyebrow>
            <div className="w-th w-srow"><span /><span>{tr('wealth_Sessions.item')}</span><span className="r">{tr('wealth_Sessions.qty')}</span><span className="r">{tr('wealth_Sessions.value')}</span><span /></div>
            <div className="w-rows">
              {rows(c.spent, true)}
              {c.spent.length === 0 && <div className="w-none">{tr('wealth_Sessions.nothing_was_used_up')}</div>}
            </div>
          </Panel>
        </div>
      </div>
      {cmp && <CompareDialog s={s} session={c} onClose={() => setCmp(false)} />}
    </div>
  );
}

/** The session set against one strategy's expected figures, with the differences. */
function CompareDialog({ s, session, onClose }: { s: Wealth; session: SessionView; onClose: () => void }) {
  const { w, strategies, fmt, go } = s;
  const all: StrategyView[] = [...strategies, ...(w?.mine ?? [])];
  const [id, setId] = useState(session.strategyId && all.some((x) => x.id === session.strategyId) ? session.strategyId : (all[0]?.id ?? ''));
  const st = all.find((x) => x.id === id);
  if (!w) return null;
  const lines = st ? compareSession(session, st) : [];
  const val = (l: CompareLine, v: number): string => (l.unit === 'chaos' ? fmt(v) : v.toFixed(1));
  const per = (l: CompareLine) => (l.label === 'Net per hour' ? '/h' : l.label === 'Cost per map' ? '/map' : '');
  const diffTxt = (l: CompareLine): string => (l.diff === null ? '—' : l.unit === 'chaos' ? fmtSigned(l.diff, w.divine) : (l.diff >= 0 ? '+' : '−') + Math.abs(l.diff).toFixed(1));
  // For cost, lower is better; for everything else higher is.
  const good = (l: CompareLine): boolean | null => (l.diff === null || Math.abs(l.diff) < 1e-9 ? null : l.label === 'Cost per map' ? l.diff < 0 : l.diff > 0);
  const net = lines[0];
  return (
    <Modal label={tr('wealth_Sessions.compare_with_a_strategy')} onClose={onClose}>
      <div className="w-dlg-h">
        <span>{tr('wealth_Sessions.compare_with_a_strategy')}</span>
        <button type="button" className="w-x" aria-label={tr('wealth_Sessions.close')} title={tr('wealth_Sessions.close')} onClick={onClose}>
          <Icon name="x" size={16} />
        </button>
      </div>
      <div className="w-dlg-b w-cmp">
        <div className="w-cmp-pick" role="listbox" aria-label={tr('wealth_Sessions.strategies')}>
          {all.length === 0 && <span className="w-none">{tr('wealth_Sessions.no_strategies_are_loaded_yet')}</span>}
          {all.map((x) => (
            <button key={x.id} type="button" role="option" aria-selected={x.id === id} data-on={x.id === id} onClick={() => setId(x.id)}>
              <span className="w-name" title={stratName(x)}>{stratName(x)}</span>
              <i>{x.mine ? tr('wealth_Sessions.yours') : x.basis === 'estimate' ? tr('wealth_Sessions.estimate') : tr('wealth_Sessions.measured')}</i>
            </button>
          ))}
        </div>
        <div className="w-cmp-r">
          {st && net && (
            <>
              <p className="w-p">
                {net.diff === null ? '' : tr(net.diff >= 0 ? 'h_c_Ws.cmp_above' : 'h_c_Ws.cmp_below', { session: sessName(session), yours: (net.yours! / w.divine).toFixed(1), strategy: stratName(st), expected: (net.expected / w.divine).toFixed(1), diff: fmtSigned(Math.abs(net.diff), w.divine).slice(1) })}
              </p>
              <div className="w-cmp-t">
                <span className="w-eyebrow-t" />
                <span className="w-eyebrow-t r">{tr('wealth_Sessions.this_session')}</span>
                <span className="w-eyebrow-t r">{tr('wealth_Sessions.strategy_expects')}</span>
                <span className="w-eyebrow-t r">{tr('wealth_Sessions.difference')}</span>
                {lines.map((l) => (
                  <div key={l.label} className="w-cmp-row">
                    <span>{item(l.label)}</span>
                    <span className="r">{l.yours === null ? tr('wealth_Sessions.no_maps_counted') : `${val(l, l.yours)}${per(l)}`}</span>
                    <span className="r">{`${val(l, l.expected)}${per(l)}`}</span>
                    <span className="r" style={{ color: good(l) === null ? 'var(--text-faint)' : good(l) ? 'var(--positive-text)' : 'var(--negative-text)' }}>{diffTxt(l)}</span>
                  </div>
                ))}
              </div>
              <span className="faint w-cmp-note">{st.basis === 'estimate' ? tr('wealth_Sessions.the_strategy_figures_are_estimates') : tr('wealth_Sessions.measured_over_count_sessions', { count: st.sessionsUsed })}</span>
            </>
          )}
        </div>
      </div>
      <div className="w-dlg-f">
        <button type="button" className="w-btn alt" onClick={() => { onClose(); go('strategies', { strat: id, stTab: st?.mine ? 2 : 0 }); }} disabled={!st}>
          <Icon name="map" size={14} />
          {tr('wealth_Sessions.open_strategy')}
        </button>
        <button type="button" className="w-btn" onClick={onClose}>{tr('wealth_Sessions.done')}</button>
      </div>
    </Modal>
  );
}

function Tile({ k, v, tone }: { k: string; v: string; tone?: 'pos' | 'neg' }) {
  return (
    <div className="w-tile">
      <span className="w-eyebrow-t">{k}</span>
      <b style={{ color: tone === 'pos' ? 'var(--positive-text)' : tone === 'neg' ? 'var(--negative-text)' : undefined }}>{v}</b>
    </div>
  );
}
