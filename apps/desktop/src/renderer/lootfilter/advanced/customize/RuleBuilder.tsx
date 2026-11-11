import { useMemo, useState } from 'react';
import type { Block, Condition, Rule } from '../../../../shared/lootfilter/types.js';
import { evaluateItem } from '../../../../shared/lootfilter/evaluate.js';
import { CONDITIONS, GEM_QUALITY_TYPES, INFLUENCES, RARITIES, type ValueKind } from '../../../../shared/lootfilter/syntax.js';
import { conditionToLine } from '../../../../shared/lootfilter/blocks.js';
import { Icon } from '../../../ui';
import { useLf } from '../../lfStore';
import { tagOf } from '../shell/edits';
import { tr } from '../../../i18n';

interface Row {
  key: string;
  op: string;
  text: string;
}

const NUM_OPS = [
  { v: '=', l: tr('h_lootB_RB.equals') },
  { v: '!=', l: tr('lootfilter_advanced_customize_RuleBuilder_2.is_not') },
  { v: '<', l: tr('h_lootB_RB.below') },
  { v: '<=', l: tr('lootfilter_advanced_customize_RuleBuilder_2.at_most') },
  { v: '>', l: tr('h_lootB_RB.above') },
  { v: '>=', l: tr('lootfilter_advanced_customize_RuleBuilder_2.at_least') },
];
const OPS: Record<ValueKind, { v: string; l: string }[]> = {
  bool: [{ v: '', l: tr('h_lootB_RB.is') }, { v: '!=', l: tr('lootfilter_advanced_customize_RuleBuilder_2.is_not') }],
  num: NUM_OPS,
  strlist: [{ v: '', l: tr('h_lootB_RB.contains') }, { v: '==', l: tr('lootfilter_advanced_customize_RuleBuilder_2.is_exactly') }, { v: '!=', l: tr('lootfilter_advanced_customize_RuleBuilder_2.is_not') }],
  rarity: [{ v: '', l: tr('h_lootB_RB.is') }, { v: '!=', l: tr('lootfilter_advanced_customize_RuleBuilder_2.is_not') }, ...NUM_OPS.slice(2)],
  sockets: [{ v: '', l: tr('h_lootB_RB.is') }, ...NUM_OPS.filter((o) => o.v !== '!=')],
  influence: [{ v: '', l: tr('h_lootB_RB.has') }],
  hasmod: [{ v: '', l: tr('h_lootB_RB.has') }],
  boolorstr: [{ v: '', l: tr('h_lootB_RB.is') }, { v: '!=', l: tr('lootfilter_advanced_customize_RuleBuilder_2.is_not') }],
  gemquality: [{ v: '', l: tr('h_lootB_RB.is') }],
};

const KEYS = Object.entries(CONDITIONS)
  .filter(([, s]) => !s.poe2 && !s.deleted)
  .map(([k]) => k);

const splitList = (t: string): string[] =>
  t
    .split(/[,\n]/)
    .map((x) => x.trim().replace(/^"|"$/g, ''))
    .filter(Boolean);

function toCondition(r: Row): { c?: Condition; err?: string } {
  const spec = CONDITIONS[r.key];
  const t = r.text.trim();
  if (!spec) return { err: tr('lootfilter_advanced_customize_RuleBuilder.key_is_not_a_condition', { key: r.key }) };
  if (!t) return { err: tr('lootfilter_advanced_customize_RuleBuilder.key_needs_a_value', { key: r.key }) };
  switch (spec.kind) {
    case 'bool':
      return { c: { key: r.key, op: r.op, values: [/^f/i.test(t) ? 'False' : 'True'] } };
    case 'num':
      return /^-?\d+$/.test(t) ? { c: { key: r.key, op: r.op, values: [t] } } : { err: tr('lootfilter_advanced_customize_RuleBuilder.key_needs_one_whole_number', { key: r.key }) };
    case 'sockets':
      return /^\d*[RGBADW]*$/.test(t) ? { c: { key: r.key, op: r.op, values: [t] } } : { err: tr('lootfilter_advanced_customize_RuleBuilder.key_needs_a_count_and', { key: r.key }) };
    case 'rarity': {
      const v = splitList(t);
      const bad = v.find((x) => !(RARITIES as readonly string[]).includes(x));
      return bad ? { err: tr('lootfilter_advanced_customize_RuleBuilder.bad_is_not_one_of', { bad }) } : { c: { key: r.key, op: r.op, values: v } };
    }
    case 'influence': {
      const v = splitList(t);
      const bad = v.find((x) => !(INFLUENCES as readonly string[]).includes(x));
      return bad ? { err: tr('lootfilter_advanced_customize_RuleBuilder.bad_is_not_an_influence', { bad }) } : { c: { key: r.key, op: r.op, values: v } };
    }
    case 'gemquality': {
      const v = splitList(t);
      const bad = v.find((x) => !(GEM_QUALITY_TYPES as readonly string[]).includes(x));
      return bad ? { err: tr('lootfilter_advanced_customize_RuleBuilder.bad_is_not_a_gem', { bad }) } : { c: { key: r.key, op: r.op, values: v } };
    }
    default:
      return { c: { key: r.key, op: r.op, values: splitList(t) } };
  }
}

export function RuleBuilder({ sectionType, onClose, onSaved }: { sectionType: string; onClose: () => void; onSaved: (id: string) => void }) {
  const lf = useLf();
  const cat = lf.catalog;
  const [act, setAct] = useState<'show' | 'hide'>('show');
  const [rows, setRows] = useState<Row[]>([{ key: 'BaseType', op: '==', text: '' }]);
  const [look, setLook] = useState('');
  const [prio, setPrio] = useState(false);

  const parsed = rows.map(toCondition);
  const err = parsed.find((p) => p.err)?.err;
  const conds = parsed.map((p) => p.c).filter((c): c is Condition => !!c);
  const valid = rows.length > 0 && !err && conds.length === rows.length;

  const classes = useMemo(() => [...new Set((cat?.items ?? []).map((i) => i.class).filter((c): c is string => !!c))], [cat]);
  const matchCount = useMemo(() => {
    if (!cat || !valid) return null;
    const blk: Block = { kind: 'Show', headerComment: '', conditions: conds, lines: [], continue: false, line: 0, endLine: 0 };
    let n = 0;
    for (const it of cat.items) if (evaluateItem([blk], lf.propsOf(it)).matched.length > 0) n++;
    return n;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cat, valid, JSON.stringify(conds)]);

  const lookTiers = useMemo(() => {
    const ty = cat?.types.find((t) => t.type === sectionType) ?? cat?.types.find((t) => t.type === 'currency');
    return (ty?.tiers ?? []).filter((t) => t.kind !== 'Hide' && Object.keys(t.style).length > 0).slice(0, 30);
  }, [cat, sectionType]);

  const suggest = (r: Row): string[] => {
    const spec = CONDITIONS[r.key];
    const last = (r.text.split(',').pop() ?? '').trim().toLowerCase();
    if (r.key === 'BaseType') return last ? (cat?.items ?? []).filter((i) => i.name.toLowerCase().includes(last)).slice(0, 8).map((i) => i.name) : [];
    if (r.key === 'Class') return classes.filter((c) => !last || c.toLowerCase().includes(last)).slice(0, 8);
    if (!spec) return [];
    if (spec.kind === 'bool') return ['True', 'False'];
    if (spec.kind === 'rarity') return [...RARITIES];
    if (spec.kind === 'influence') return [...INFLUENCES];
    if (spec.kind === 'gemquality') return [...GEM_QUALITY_TYPES];
    return [];
  };
  const pick = (i: number, s: string): void => {
    setRows((rs) =>
      rs.map((r, j) => {
        if (j !== i) return r;
        const multi = CONDITIONS[r.key]?.kind !== 'bool' && CONDITIONS[r.key]?.kind !== 'num';
        const parts = r.text.split(',').map((x) => x.trim()).filter(Boolean);
        if (multi && r.text.trim() && !r.text.trim().endsWith(',')) parts.pop();
        return { ...r, text: multi ? [...parts, s].join(', ') : s };
      }),
    );
  };

  const nameOf = (): string => `${act === 'hide' ? 'Hide' : 'Show'} ${conds.map((c) => conditionToLine(c).replace(/\s+/g, ' ')).join(', ').slice(0, 60)}`;
  const save = (): void => {
    if (!valid) return;
    const rule: Rule = {
      id: lf.newId('r'),
      name: nameOf(),
      source: 'advanced',
      enabled: true,
      priority: lf.nextPriority(),
      targets: [{ conditions: conds }],
      visibility: act,
      ...(act === 'show' && look ? { styleFrom: tagOf(cat?.tierByKey.get(look) ?? { type: '', tier: '' }) } : {}),
      createdAt: Date.now(),
    };
    lf.addRule(rule, tr('lootfilter_advanced_customize_RuleBuilder.added_a_rule'));
    onSaved(rule.id);
  };

  const firstUser = lf.genBlocks.find((b) => b.ruleId);
  const above = lf.genBlocks.filter((b) => b.ruleId).slice(0, 3);
  const nameOfRule = (id: string | undefined): string => lf.doc.rules.find((r) => r.id === id)?.name ?? tr('lootfilter_advanced_customize_RuleBuilder.your_rule');

  return (
    <div className="adv-cz-new" data-screen-label="Loot Filter / Customize / New rule">
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <span className="lf-eyebrow">{tr('lootfilter_advanced_customize_RuleBuilder.new_rule')}</span>
        <span style={{ flex: 1 }} />
        <span className="adv-sh-seg" role="group" aria-label={tr('lootfilter_advanced_customize_RuleBuilder.what_the_rule_does')}>
          <button type="button" aria-pressed={act === 'show'} onClick={() => setAct('show')}>
            {tr('lootfilter_advanced_customize_RuleBuilder.show')}
          </button>
          <button type="button" aria-pressed={act === 'hide'} onClick={() => setAct('hide')}>
            {tr('lootfilter_advanced_customize_RuleBuilder.hide')}
          </button>
        </span>
      </div>
      {rows.map((r, i) => {
        const spec = CONDITIONS[r.key];
        const ops = OPS[spec?.kind ?? 'strlist'];
        const sug = suggest(r);
        return (
          <div key={i} style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <div className="adv-cz-nrrow">
              <select
                className="adv-cz-sel"
                aria-label={tr('lootfilter_advanced_customize_RuleBuilder.condition')}
                value={r.key}
                onChange={(e) => {
                  const k = e.target.value;
                  const o = OPS[CONDITIONS[k]?.kind ?? 'strlist'];
                  setRows((rs) => rs.map((x, j) => (j === i ? { key: k, op: o.some((p) => p.v === x.op) ? x.op : o[0]!.v, text: '' } : x)));
                }}
              >
                {KEYS.map((k) => (
                  <option key={k} value={k}>
                    {k}
                  </option>
                ))}
              </select>
              <select className="adv-cz-sel" aria-label={tr('lootfilter_advanced_customize_RuleBuilder.operator')} value={r.op} onChange={(e) => setRows((rs) => rs.map((x, j) => (j === i ? { ...x, op: e.target.value } : x)))}>
                {ops.map((o) => (
                  <option key={o.v} value={o.v}>
                    {o.l}
                  </option>
                ))}
              </select>
              <input className="adv-sh-field" style={{ height: 32 }} aria-label={tr('lootfilter_advanced_customize_RuleBuilder.values')} placeholder={r.key === 'BaseType' ? tr('lootfilter_advanced_customize_RuleBuilder.type_to_search_neversink_base') : r.key === 'Class' ? tr('lootfilter_advanced_customize_RuleBuilder.type_to_search_item_classes') : tr('lootfilter_advanced_customize_RuleBuilder.value')} value={r.text} onChange={(e) => setRows((rs) => rs.map((x, j) => (j === i ? { ...x, text: e.target.value } : x)))} />
              <button type="button" className="adv-sh-ib" title={tr('lootfilter_advanced_customize_RuleBuilder.remove_condition')} aria-label={tr('lootfilter_advanced_customize_RuleBuilder.remove_condition')} onClick={() => setRows((rs) => rs.filter((_, j) => j !== i))} disabled={rows.length === 1}>
                <Icon name="x" size={14} />
              </button>
            </div>
            {sug.length > 0 && (
              <div className="adv-cz-sug">
                {sug.map((s) => (
                  <button key={s} type="button" onClick={() => pick(i, s)}>
                    {s}
                  </button>
                ))}
              </div>
            )}
          </div>
        );
      })}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        <button type="button" className="adv-sh-btn text sm" onClick={() => setRows((rs) => [...rs, { key: 'Rarity', op: '', text: '' }])}>
          <Icon name="plus" size={14} />
          {tr('lootfilter_advanced_customize_RuleBuilder.add_condition')}
        </button>
        <span style={{ color: err ? 'var(--warning-text)' : 'var(--text-2)', fontSize: 12.5, fontVariantNumeric: 'tabular-nums' }}>
          {err ?? (matchCount !== null && cat ? tr('lootfilter_advanced_customize_RuleBuilder.tolocalestring_of_tolocalestring2_na', { matchCount: matchCount.toLocaleString(), count: cat.items.length.toLocaleString() }) : '')}
        </span>
        <span style={{ flex: 1 }} />
        {act === 'show' && (
          <label style={{ display: 'flex', alignItems: 'center', gap: 6, color: 'var(--text-muted)', fontSize: 12.5 }}>
            {tr('lootfilter_advanced_customize_RuleBuilder.look')}
            <select className="adv-cz-sel" style={{ maxWidth: 190 }} aria-label={tr('lootfilter_advanced_customize_RuleBuilder.look')} value={look} onChange={(e) => setLook(e.target.value)}>
              <option value="">{tr('lootfilter_advanced_customize_RuleBuilder.the_game_s_default_look')}</option>
              {lookTiers.map((t) => (
                <option key={t.key} value={t.key}>
                  {tr('lootfilter_advanced_customize_RuleBuilder.like_label', { label: t.label })}
                </option>
              ))}
            </select>
          </label>
        )}
        <button type="button" className="adv-sh-btn" title={tr('lootfilter_advanced_customize_RuleBuilder.where_this_rule_sits_among')} onClick={() => setPrio((p) => !p)}>
          <Icon name="list-ordered" size={14} />
          {tr('lootfilter_advanced_customize_RuleBuilder.show_priority')}
        </button>
        <button type="button" className="adv-sh-btn" onClick={onClose}>
          <Icon name="trash" size={14} />
          {tr('lootfilter_advanced_customize_RuleBuilder.discard')}
        </button>
        <button type="button" className="adv-sh-btn gold" disabled={!valid} onClick={save}>
          <Icon name="save" size={14} />
          {tr('lootfilter_advanced_customize_RuleBuilder.save_rule')}
        </button>
      </div>
      {prio && (
        <div className="adv-cz-prio" data-screen-label="Loot Filter / Customize / Show priority">
          <span style={{ color: 'var(--text-muted)' }}>
            {tr('lootfilter_advanced_customize_RuleBuilder.the_first_rule_that_matches')} {firstUser ? tr('lootfilter_advanced_customize_RuleBuilder.before_line_line', { line: firstUser.line }) : lf.gen ? tr('lootfilter_advanced_customize_RuleBuilder.before_neversink_s_base_at', { baseStartLine: lf.gen.baseStartLine }) : tr('lootfilter_advanced_customize_RuleBuilder.at_the_top_of_the')}.
          </span>
          <div style={{ display: 'grid', gridTemplateColumns: '64px minmax(0,1fr)', gap: '4px 10px', fontVariantNumeric: 'tabular-nums' }}>
            <span style={{ color: 'var(--gold-text)', fontFamily: "'Geist Mono'" }}>{firstUser ? firstUser.line : '-'}</span>
            <span style={{ color: 'var(--text-strong)', fontWeight: 500 }}>{tr('lootfilter_advanced_customize_RuleBuilder.this_new_rule')}</span>
            {above.map((b) => (
              <span key={b.line} style={{ display: 'contents' }}>
                <span style={{ color: 'var(--text-faint)', fontFamily: "'Geist Mono'" }}>{b.line}</span>
                <span style={{ color: 'var(--text-2)' }}>{nameOfRule(b.ruleId)}</span>
              </span>
            ))}
            {lf.gen && (
              <span style={{ display: 'contents' }}>
                <span style={{ color: 'var(--text-faint)', fontFamily: "'Geist Mono'" }}>{lf.gen.baseStartLine}</span>
                <span style={{ color: 'var(--text-2)' }}>{tr('lootfilter_advanced_customize_RuleBuilder.neversink_base_starts_here')}</span>
              </span>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
