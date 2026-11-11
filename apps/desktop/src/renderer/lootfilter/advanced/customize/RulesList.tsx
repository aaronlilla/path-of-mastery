import { useMemo, useState } from 'react';
import type { Block, Rule } from '../../../../shared/lootfilter/types.js';
import { evaluateItem } from '../../../../shared/lootfilter/evaluate.js';
import { hidesCount } from '../../hidesText';
import { tagKey } from '../../../../shared/lootfilter/blocks.js';
import { Icon } from '../../../ui';
import { LabelChip, groundFor } from '../../LabelChip';
import { useLf } from '../../lfStore';
import { currentLook } from '../shell/edits';
import { useAdvShell } from '../shell/selection';
import { SOURCE, ruleText } from './model';
import { tr } from '../../../i18n';
import { lfBuild, lfText } from '../../mainText';

/** Your rules, highest priority first (the first rule that matches an item wins). */
export function RulesList({ onlyBuild }: { onlyBuild: boolean }) {
  const lf = useLf();
  const sh = useAdvShell();
  const cat = lf.catalog;
  const [dragId, setDragId] = useState<string | null>(null);
  const [overId, setOverId] = useState<string | null>(null);
  const bright = sh.ground === 'bright';
  const ordered = useMemo(() => [...lf.doc.rules].sort((a, b) => b.priority - a.priority), [lf.doc.rules]);
  const rules = onlyBuild ? ordered.filter((r) => r.source === 'build') : ordered;
  const lineOf = useMemo(() => {
    const m = new Map<string, number>();
    for (const b of lf.genBlocks) if (b.ruleId && !m.has(b.ruleId)) m.set(b.ruleId, b.line);
    return m;
  }, [lf.genBlocks]);
  const applied = useMemo(() => new Map((lf.gen?.applied ?? []).map((a) => [a.ruleId, a])), [lf.gen]);
  const review = useMemo(() => new Map((lf.gen?.needsReview ?? []).map((n) => [n.ruleId, lfText(n.message)])), [lf.gen]);

  // How many item types each Hide rule matches in NeverSink's item list.
  const hides = useMemo(() => {
    const m = new Map<string, number>();
    if (!cat) return m;
    for (const rule of lf.doc.rules) {
      if (rule.visibility !== 'hide') continue;
      const blocks: Block[] = rule.targets.map((t) => ({ kind: 'Show', headerComment: '', conditions: t.conditions ?? [], lines: [], continue: false, line: 0, endLine: 0 }));
      let n = 0;
      for (const it of cat.items) {
        const props = lf.propsOf(it);
        if (blocks.some((b) => evaluateItem([b], props).matched.length > 0)) n++;
      }
      m.set(rule.id, n);
    }
    return m;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cat, lf.doc.rules]);

  const moveTo = (id: string, targetId: string): void => {
    const from = ordered.findIndex((r) => r.id === id);
    const to = ordered.findIndex((r) => r.id === targetId);
    if (from < 0 || to < 0 || from === to) return;
    const next = [...ordered];
    const [m] = next.splice(from, 1);
    next.splice(to, 0, m!);
    // The list is highest priority first, so the top row gets the biggest number.
    const prio = new Map(next.map((r, i) => [r.id, next.length - i]));
    lf.setRules(tr('lootfilter_advanced_customize_RulesList.reordered_rules'), (rs) => rs.map((r) => ({ ...r, priority: prio.get(r.id) ?? r.priority })));
  };

  if (!rules.length)
    return (
      <div style={{ padding: '28px 12px', color: 'var(--text-muted)', textAlign: 'center', lineHeight: 1.5 }}>
        {onlyBuild ? tr('lootfilter_advanced_customize_RulesList.no_rules_came_from_your') : tr('lootfilter_advanced_customize_RulesList.you_have_no_rules_yet')}
      </div>
    );

  return (
    <>
      {rules.map((r: Rule, idx) => {
        const src = SOURCE[r.source];
        const look = currentLook(lf, { kind: 'rule', rule: r });
        const a = applied.get(r.id);
        const line = lineOf.get(r.id);
        const sample = r.targets.flatMap((t) => (t.conditions ?? []).filter((c) => c.key === 'BaseType').flatMap((c) => c.values))[0] ?? (r.targets[0]?.tag ? (cat?.tierByKey.get(tagKey(r.targets[0].tag))?.label ?? tr('lootfilter_advanced_customize_RulesList_2.sample')) : tr('lootfilter_advanced_customize_RulesList_2.sample'));
        const sel = sh.selected?.kind === 'rule' && sh.selected.id === r.id;
        const msg = review.get(r.id);
        return (
          <div
            key={r.id}
            id={`adv-cz-rule-${r.id}`}
            className="adv-cz-rule"
            draggable
            onDragStart={(e) => {
              setDragId(r.id);
              e.dataTransfer.effectAllowed = 'move';
              try {
                e.dataTransfer.setData('text/plain', r.id);
              } catch {
                // fine
              }
            }}
            onDragEnd={() => {
              setDragId(null);
              setOverId(null);
            }}
            onDragOver={(e) => {
              if (!dragId) return;
              e.preventDefault();
              setOverId(r.id);
            }}
            onDrop={(e) => {
              e.preventDefault();
              if (dragId) moveTo(dragId, r.id);
              setDragId(null);
              setOverId(null);
            }}
            onClick={() => {
              sh.select({ kind: 'rule', id: r.id });
              sh.openInspector();
            }}
            style={{ borderColor: overId === r.id ? 'var(--gold-400)' : sel ? 'rgba(var(--accent-rgb),.5)' : 'rgba(var(--line-rgb),.09)', background: sel ? 'rgba(var(--accent-rgb),.06)' : 'rgba(var(--shadow-rgb),calc(.18*var(--shadow-k)))', opacity: r.enabled ? 1 : 0.65 }}
          >
            <input type="checkbox" checked={r.enabled} aria-label={tr('lootfilter_advanced_customize_RulesList.rule_on')} style={{ width: 15, height: 15, accentColor: 'var(--gold-400)', margin: 0 }} onClick={(e) => e.stopPropagation()} onChange={() => lf.updateRule(r.id, { enabled: !r.enabled }, r.enabled ? tr('lootfilter_advanced_customize_RulesList.turned_a_rule_off') : tr('lootfilter_advanced_customize_RulesList.turned_a_rule_on'))} />
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6, minWidth: 0 }}>
              <span style={{ color: 'var(--text-strong)', lineHeight: 1.5, textWrap: 'pretty' }}>{ruleText(r, cat)}</span>
              <span style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap', fontSize: 12, color: 'var(--text-muted)' }}>
                <span style={{ color: src.colour, fontWeight: 500 }}>{src.label}</span>
                <span>{!r.enabled ? tr('lootfilter_advanced_customize_RulesList.off') : a ? `${a.written ? tr(a.written === 1 ? 'h_lootB_RulesList.writes_one' : 'h_lootB_RulesList.writes_other', { n: a.written }) : ''}${a.written && a.restyled ? ', ' : ''}${a.restyled ? tr(a.restyled === 1 ? 'h_lootB_RulesList.restyles_one' : 'h_lootB_RulesList.restyles_other', { n: a.restyled }) : ''}` : tr('lootfilter_advanced_customize_RulesList.no_effect_on_the_file')}</span>
                {r.enabled && hides.has(r.id) && <span>{hidesCount(hides.get(r.id)!)}</span>}
                {line !== undefined && <span style={{ font: "500 11px 'Geist Mono'", color: 'var(--text-faint)' }}>{tr('lootfilter_advanced_customize_RulesList.line_line', { line })}</span>}
                {r.why && <span title={lfBuild(r.why)}>{lfBuild(r.why).length > 60 ? lfBuild(r.why).slice(0, 58) + '...' : lfBuild(r.why)}</span>}
              </span>
              {msg && <span style={{ color: 'var(--warning-text)', fontSize: 12 }}>{tr('lootfilter_advanced_customize_RulesList.needs_review_msg', { msg })}</span>}
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <div style={{ padding: '8px 10px', borderRadius: 8, background: groundFor(bright ? 'bright' : 'desert'), display: 'flex', alignItems: 'center' }}>
                <LabelChip name={sample} style={look} fontPx={18} hidden={r.visibility === 'hide'} hiddenLook="fade" bright={bright} />
              </div>
              <div style={{ display: 'flex', flexDirection: 'column' }}>
                <button type="button" className="adv-sh-ib sm" style={{ width: 24, height: 18 }} title={tr('lootfilter_advanced_customize_RulesList.move_up_checked_first')} aria-label={tr('lootfilter_advanced_customize_RulesList.move_rule_up')} disabled={idx === 0} onClick={(e) => { e.stopPropagation(); const o = rules[idx - 1]; if (o) moveTo(r.id, o.id); }}>
                  <Icon name="chevron-up" size={12} />
                </button>
                <button type="button" className="adv-sh-ib sm" style={{ width: 24, height: 18 }} title={tr('lootfilter_advanced_customize_RulesList.move_down_checked_later')} aria-label={tr('lootfilter_advanced_customize_RulesList.move_rule_down')} disabled={idx === rules.length - 1} onClick={(e) => { e.stopPropagation(); const o = rules[idx + 1]; if (o) moveTo(r.id, o.id); }}>
                  <Icon name="chevron-down" size={12} />
                </button>
              </div>
              <button
                type="button"
                className="adv-sh-ib sm"
                title={tr('lootfilter_advanced_customize_RulesList.delete_this_rule')}
                aria-label={tr('lootfilter_advanced_customize_RulesList.delete_rule')}
                onClick={(e) => {
                  e.stopPropagation();
                  lf.removeRule(r.id, tr('lootfilter_advanced_customize_RulesList_2.deleted_a_rule'));
                  sh.toastUndo(tr('lootfilter_advanced_customize_RulesList_2.deleted_the_rule'));
                }}
              >
                <Icon name="trash" size={14} />
              </button>
            </div>
          </div>
        );
      })}
    </>
  );
}
