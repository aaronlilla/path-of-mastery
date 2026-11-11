import { useRef } from 'react';
import type { EvalResult, EvalStep } from '../../../../shared/lootfilter/evaluate.js';
import { conditionToLine } from '../../../../shared/lootfilter/blocks.js';
import { Icon, useDismiss } from '../../../ui';
import { LabelChip } from '../../LabelChip';
import { useLf } from '../../lfStore';
import type { LfNav } from '../../LootFilterArea';
import type { SimItem } from './parseItem';
import './adv-v.css';
import { tr } from '../../../i18n';

/**
 * The real rule stack for one item: which block decided, which others matched, and which came close.
 * A local stand-in for the shell's Explain drawer; it reads the same EvalResult the shell would.
 */
export function ExplainPanel({ item, result, nav, onClose }: { item: SimItem; result: EvalResult; nav: LfNav; onClose: () => void }) {
  const lf = useLf();
  const panel = useRef<HTMLElement>(null);
  useDismiss(panel, true, onClose, true);
  const decided = result.decided;
  const rule = decided?.ruleId ? lf.doc.rules.find((r) => r.id === decided.ruleId) : undefined;
  const matchedSet = new Set(result.matched);
  // The nearest blocks above the decider that failed on one condition, which is what a player wants to know ("why not that one?").
  const decidedIdx = decided ? result.steps.findIndex((s) => s.block === decided) : result.steps.length;
  const near: EvalStep[] = result.steps
    .slice(0, Math.max(0, decidedIdx))
    .filter((s) => s.result !== 'match' && s.block.conditions.length > 0 && (s.block.ruleId || s.block.tag))
    .slice(-6);
  const kindOf = (k: string): string => (k === 'Show' ? 'show' : 'hide');
  const p = item.props;
  const facts = [
    p.rarity,
    p.itemLevel !== undefined ? tr('lootfilter_advanced_sim_ExplainPanel_2.item_level', { itemLevel: p.itemLevel }) : undefined,
    p.class,
    p.linkedSockets ? tr('lootfilter_advanced_sim_ExplainPanel_2.linked', { linkedSockets: p.linkedSockets }) : undefined,
    p.stackSize && p.stackSize > 1 ? tr('lootfilter_advanced_sim_ExplainPanel_2.stack_of', { stackSize: p.stackSize }) : undefined,
    p.corrupted ? 'corrupted' : undefined,
  ].filter(Boolean);

  return (
    <>
      <div className="adv-ex-back" onClick={onClose} />
      <aside ref={panel} className="adv-ex" role="dialog" aria-label={tr('lootfilter_advanced_sim_ExplainPanel.explain_this_item')}>
        <div style={{ padding: '14px 16px', display: 'flex', alignItems: 'center', gap: 10, borderBottom: '1px solid rgba(var(--line-rgb),.06)' }}>
          <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 6 }}>
            <span className="lf-eyebrow">{tr('lootfilter_advanced_sim_ExplainPanel.why_this_item_looks_like')}</span>
            <span style={{ display: 'inline-flex', background: 'radial-gradient(120% 90% at 50% 40%,#2a2419,#0d0b08)', padding: '6px 8px', borderRadius: 7, alignSelf: 'flex-start' }}>
              <LabelChip name={item.display} style={result.style} fontPx={18} hidden={!result.visible} hiddenLook="fade" />
            </span>
            <span className="adv-v-muted">{facts.join(' · ') || tr('lootfilter_advanced_sim_ExplainPanel.no_details_known_about_this')}</span>
          </div>
          <button type="button" className="btn ghost sm" aria-label={tr('lootfilter_advanced_sim_ExplainPanel.close')} onClick={onClose}>
            <Icon name="x" size={16} />
          </button>
        </div>
        <div className="adv-ex-body">
          <div className={'adv-v-msg ' + (result.visible ? 'ok' : 'warn')}>
            {result.visible ? tr('lootfilter_advanced_sim_ExplainPanel.shown') : tr('lootfilter_advanced_sim_ExplainPanel.hidden')}{' '}
            {decided
              ? rule
                ? tr('lootfilter_advanced_sim_ExplainPanel.your_rule_name_decided_this', { name: rule.name ?? tr('h_lootB_Sect.untitled_rule') })
                : decided.ruleId
                  ? tr('lootfilter_advanced_sim_ExplainPanel.one_of_your_rules_decided')
                  : decided.tag
                    ? tr('lootfilter_advanced_sim_ExplainPanel_2.neversink_s_block_decided_this', { type: decided.tag.type, tier: decided.tag.tier })
                    : tr('lootfilter_advanced_sim_ExplainPanel.a_neversink_block_decided_this')
              : tr('lootfilter_advanced_sim_ExplainPanel.no_block_matched_so_the')}
            {result.uncertain && tr('lootfilter_advanced_sim_ExplainPanel.some_rules_test_details_this')}
          </div>
          {decided && (
            <div className="adv-ex-step decided">
              <div className="adv-v-row">
                <span className={'adv-ex-kind ' + kindOf(decided.kind)}>{decided.kind.toUpperCase()}</span>
                <span className="adv-v-strong adv-v-ellip" style={{ flex: 1 }}>{decided.headerComment || (decided.tag ? `${decided.tag.type} ${decided.tag.tier}` : tr('lootfilter_advanced_sim_ExplainPanel.block'))}</span>
                <span className="adv-v-muted">{tr('lootfilter_advanced_sim_ExplainPanel.line_line', { line: decided.line })}</span>
              </div>
              {decided.section && <span className="adv-v-muted">{decided.section}</span>}
              <div className="adv-v-mono" style={{ color: 'var(--text-2)', display: 'flex', flexDirection: 'column', gap: 1 }}>
                {decided.conditions.map((c, i) => (
                  <span key={i}>{conditionToLine(c)}</span>
                ))}
              </div>
              <div className="adv-v-row" style={{ gap: 6, marginTop: 4 }}>
                {rule && (
                  <button type="button" className="btn sm" onClick={() => nav.openAdvanced('customize', { ruleId: rule.id })}>
                    <Icon name="edit" size={14} />
                    {tr('lootfilter_advanced_sim_ExplainPanel.open_this_rule')}
                  </button>
                )}
                <button type="button" className="btn sm" onClick={() => nav.setAdvancedView('raw')}>
                  <Icon name="code" size={14} />
                  {tr('lootfilter_advanced_sim_ExplainPanel.show_in_the_filter_text')}
                </button>
              </div>
            </div>
          )}
          {result.matched.filter((b) => b !== decided).length > 0 && (
            <>
              <span className="lf-eyebrow" style={{ marginTop: 4 }}>{tr('lootfilter_advanced_sim_ExplainPanel.also_matched_continue')}</span>
              {result.matched
                .filter((b) => b !== decided)
                .map((b, i) => (
                  <div key={i} className="adv-ex-step">
                    <div className="adv-v-row">
                      <span className={'adv-ex-kind ' + kindOf(b.kind)}>{b.kind.toUpperCase()}</span>
                      <span className="adv-v-ellip" style={{ flex: 1, color: 'var(--text-2)' }}>{b.headerComment || tr('lootfilter_advanced_sim_ExplainPanel.block')}</span>
                      <span className="adv-v-muted">{tr('lootfilter_advanced_sim_ExplainPanel.line_line', { line: b.line })}</span>
                    </div>
                  </div>
                ))}
            </>
          )}
          {near.length > 0 && (
            <>
              <span className="lf-eyebrow" style={{ marginTop: 4 }}>{tr('lootfilter_advanced_sim_ExplainPanel.close_but_not_matched')}</span>
              {near.map((s, i) => (
                <div key={i} className="adv-ex-step">
                  <div className="adv-v-row">
                    <span className={'adv-ex-kind ' + kindOf(s.block.kind)}>{s.block.kind.toUpperCase()}</span>
                    <span className="adv-v-ellip" style={{ flex: 1, color: 'var(--text-2)' }}>{s.block.headerComment || tr('lootfilter_advanced_sim_ExplainPanel.block')}</span>
                    <span className="adv-v-muted">{tr('lootfilter_advanced_sim_ExplainPanel.line_line', { line: s.block.line })}</span>
                  </div>
                  {s.failed && (
                    <span className="adv-v-muted">
                      {matchedSet.has(s.block) ? '' : s.result === 'unknown' ? tr('lootfilter_advanced_sim_ExplainPanel.cannot_tell') : tr('lootfilter_advanced_sim_ExplainPanel.stopped_at')}
                      <span className="adv-v-mono">{conditionToLine(s.failed)}</span>
                    </span>
                  )}
                </div>
              ))}
            </>
          )}
        </div>
      </aside>
    </>
  );
}
