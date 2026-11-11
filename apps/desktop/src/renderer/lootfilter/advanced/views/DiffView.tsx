import { useEffect, useState } from 'react';
import { Icon, useToast } from '../../../ui';
import { LabelChip } from '../../LabelChip';
import { useLf } from '../../lfStore';
import type { LfNav } from '../../LootFilterArea';
import { removeProposal, setChangeStatus, useProposals, type LookState, type ProposedChange } from '../diffStore';
import { applyChanges } from '../review/build';
import { Eyebrow } from '../sim/kit';
import { plain } from '../strictness/kit';
import '../sim/adv-v.css';
import { tr } from '../../../i18n';
import { lfText } from '../../mainText';

function Look({ s }: { s: LookState }) {
  return (
    <span className="adv-v-ground" style={{ background: 'radial-gradient(120% 90% at 50% 40%,#2a2419,#0d0b08)' }}>
      <LabelChip name={s.name} style={plain(s.style)} fontPx={15} hidden={!!s.hidden} hiddenLook="fade" {...(s.tag ? { hidTag: s.tag } : {})} />
    </span>
  );
}

import { plural } from './plural';

/** The review panel: every proposed change with its before and after, applied only when the player says so. */
export function DiffView({ nav }: { nav: LfNav }) {
  const lf = useLf();
  const toast = useToast();
  const proposals = useProposals();
  const p = proposals[0];
  // Ticked changes. Flagged changes start unticked; the rest start ticked.
  const [ticked, setTicked] = useState<Record<string, boolean>>({});
  useEffect(() => {
    if (!p) return;
    setTicked((t) => {
      const next = { ...t };
      for (const c of p.changes) if (next[c.id] === undefined) next[c.id] = !c.flag;
      return next;
    });
  }, [p]);

  if (!p) {
    return (
      <div className="lf-card" style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 8, textAlign: 'center', padding: 24 }}>
        <span style={{ font: "600 22px 'Cormorant Garamond',serif", color: 'var(--text-display)' }}>{tr('lootfilter_advanced_views_DiffView.nothing_to_review')}</span>
        <span className="adv-v-muted" style={{ maxWidth: 440, lineHeight: 1.5 }}>{tr('lootfilter_advanced_views_DiffView.when_ask_or_adapt_proposes')}</span>
        <button type="button" className="btn sm" onClick={() => nav.setAdvancedView('overview')}>
          {tr('lootfilter_advanced_views_DiffView.back_to_overview')}
        </button>
      </div>
    );
  }

  const pending = p.changes.filter((c) => c.status === 'pending');
  const sel = pending.filter((c) => ticked[c.id]);
  const allowed = pending.filter((c) => !c.flag || ticked[c.id]);
  const allDone = pending.length === 0;
  const groups = [...new Set(p.changes.map((c) => c.group))];
  const items = p.changes.reduce((n, c) => n + (c.affected ?? 0), 0);

  const apply = (list: ProposedChange[], label: string): void => {
    if (!list.length) return;
    applyChanges(lf, list, label);
    setChangeStatus(p.id, list.map((c) => c.id), 'applied');
    toast({ text: tr('lootfilter_advanced_views_DiffView.length_applied_undo_is_in', { value: plural(list.length, 'change') }), kind: 'ok' });
  };

  return (
    <div className="lf-card" style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', overflow: 'hidden', borderColor: 'rgba(var(--accent-rgb),.3)' }}>
      <div className="adv-v-row" style={{ padding: '14px 16px', gap: 12, borderBottom: '1px solid rgba(var(--line-rgb),.06)' }}>
        <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 3 }}>
          <Eyebrow>{tr('lootfilter_advanced_views_DiffView.review_changes_from_touppercase', { source: p.source.toUpperCase() })}</Eyebrow>
          <span style={{ font: "600 22px/1.1 'Cormorant Garamond',serif", color: 'var(--text-display)' }}>{p.title}</span>
          <span className="adv-v-muted">
            {`${plural(p.changes.length, 'change')} · ${plural(groups.length, 'section')}${items ? ` · ${plural(items, 'item type')}` : ''} · ${tr('h_lootB_Views.nothing_changes')}`}
            {proposals.length > 1 ? tr('lootfilter_advanced_views_DiffView.length_more_waiting', { value: proposals.length - 1 }) : ''}
          </span>
        </div>
        <button type="button" className="btn sm" style={{ height: 34 }} onClick={() => removeProposal(p.id)}>
          <Icon name="trash" size={14} />
          {tr('lootfilter_advanced_views_DiffView.discard')}
        </button>
        <button type="button" className="btn sm" style={{ height: 34 }} disabled={!sel.length} onClick={() => apply(sel, tr('lootfilter_advanced_views_DiffView.applied_length', { value: plural(sel.length, 'reviewed change') }))}>
          {tr('lootfilter_advanced_views_DiffView.apply_selected_length', { count: sel.length })}
        </button>
        <button type="button" className="btn gold sm" style={{ height: 34, padding: '0 14px', fontSize: 13 }} disabled={!allowed.length} title={allowed.length < pending.length ? tr('lootfilter_advanced_views_DiffView.changes_with_a_warning_are') : undefined} onClick={() => apply(allowed, tr('lootfilter_advanced_views_DiffView.applied_length', { value: plural(allowed.length, 'reviewed change') }))}>
          <Icon name="check" size={14} />
          {tr('lootfilter_advanced_views_DiffView.apply_all')}
        </button>
        {allDone && (
          <button
            type="button"
            className="btn sm"
            style={{ height: 34 }}
            onClick={() => {
              removeProposal(p.id);
              nav.setAdvancedView('overview');
            }}
          >
            <Icon name="check" size={14} />
            {tr('lootfilter_advanced_views_DiffView.done')}
          </button>
        )}
      </div>
      <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', overflowX: 'hidden', padding: '8px 16px 16px' }}>
        {groups.map((g) => {
          const rows = p.changes.filter((c) => c.group === g);
          return (
            <div key={g}>
              <div className="adv-df-grp">
                <Eyebrow>{g.toUpperCase()}</Eyebrow>
                <span style={{ color: 'var(--text-faint)', fontSize: 12 }}>{plural(rows.length, 'change')}</span>
              </div>
              {rows.map((c) => {
                const open = c.status === 'pending';
                const state = c.status === 'applied' ? { l: tr('lootfilter_advanced_views_DiffView_2.applied'), c: 'var(--positive-text)' } : c.status === 'skipped' ? { l: tr('lootfilter_advanced_views_DiffView_2.skipped'), c: 'var(--text-muted)' } : c.conflict ? { l: tr('lootfilter_advanced_views_DiffView_2.conflict'), c: 'var(--gold-text)' } : { l: tr('lootfilter_advanced_views_DiffView_2.pending'), c: 'var(--text-muted)' };
                return (
                  <div key={c.id} className="adv-df-row" style={{ opacity: c.status === 'skipped' ? 0.55 : 1, borderColor: c.flag && ticked[c.id] ? 'rgba(255,153,34,.4)' : undefined }}>
                    <div className="adv-df-line">
                      <input type="checkbox" checked={!!ticked[c.id] && open} disabled={!open} aria-label={tr('lootfilter_advanced_views_DiffView.include_this_change')} style={{ width: 15, height: 15, accentColor: 'var(--gold-400)', margin: 0 }} onChange={(e) => setTicked({ ...ticked, [c.id]: e.target.checked })} />
                      <Look s={c.before} />
                      <Icon name="arrow-right" size={14} style={{ color: 'var(--text-muted)' }} />
                      <Look s={c.after} />
                      <span style={{ display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0 }}>
                        <span style={{ color: 'var(--text-strong)', lineHeight: 1.4 }}>{c.what}</span>
                        {c.why && <span className="adv-v-muted">{c.why}</span>}
                      </span>
                      <span style={{ color: 'var(--text-2)', fontSize: 12.5, fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' }}>{c.affected !== undefined ? plural(c.affected, 'item type') : ''}</span>
                      <span style={{ color: state.c, font: '500 12px Geist', whiteSpace: 'nowrap' }}>{state.l}</span>
                      <span style={{ display: 'flex', gap: 4 }}>
                        {open && (
                          <>
                            <button type="button" className="btn sm" disabled={!!c.flag && !ticked[c.id]} title={c.flag && !ticked[c.id] ? tr('lootfilter_advanced_views_DiffView.tick_hide_anyway_first') : undefined} onClick={() => apply([c], tr('lootfilter_advanced_views_DiffView.applied_a_reviewed_change'))}>
                              <Icon name="check" size={14} />
                              {tr('lootfilter_advanced_views_DiffView.apply')}
                            </button>
                            <button type="button" className="btn ghost sm" onClick={() => setChangeStatus(p.id, [c.id], 'skipped')}>
                              <Icon name="arrow-right" size={14} />
                              {tr('lootfilter_advanced_views_DiffView.skip')}
                            </button>
                          </>
                        )}
                      </span>
                    </div>
                    {c.flag && open && (
                      <div className="adv-v-row" style={{ marginLeft: 34, gap: 10, padding: '8px 10px', borderRadius: 8, background: 'rgba(255,153,34,.08)', color: 'var(--warning-text)', fontSize: 12.5, lineHeight: 1.45 }}>
                        <span style={{ flex: 1 }}>{c.flag}</span>
                        <label style={{ display: 'flex', alignItems: 'center', gap: 6, color: 'var(--text-strong)', cursor: 'pointer', whiteSpace: 'nowrap' }}>
                          <input type="checkbox" checked={!!ticked[c.id]} onChange={(e) => setTicked({ ...ticked, [c.id]: e.target.checked })} style={{ width: 15, height: 15, accentColor: 'var(--gold-400)', margin: 0 }} />
                          {tr('lootfilter_advanced_views_DiffView.hide_anyway')}
                        </label>
                      </div>
                    )}
                    {c.conflict && open && (
                      <div style={{ marginLeft: 34, padding: '8px 10px', borderRadius: 8, background: 'rgba(255,153,34,.06)', color: 'var(--warning-text)', fontSize: 12.5, lineHeight: 1.45 }}>{lfText(c.conflict)}</div>
                    )}
                  </div>
                );
              })}
            </div>
          );
        })}
      </div>
    </div>
  );
}
