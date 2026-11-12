import { useMemo, useState } from 'react';
import { tagKey, tagLabel } from '../../../../shared/lootfilter/blocks.js';
import { Icon } from '../../../ui';
import { artFor } from '../../../gameArt';
import { LabelChip, groundFor } from '../../LabelChip';
import { useLf } from '../../lfStore';
import type { LfNav } from '../../LootFilterArea';
import { useAdvShell } from './selection';
import { tr } from '../../../i18n';
import { lfBuild } from '../../mainText';

/** "Why does it look like this": the rule stack for one item, from the filter that would be written. */
export function ExplainDrawer({ name, right, onClose, nav }: { name: string; right: number; onClose: () => void; nav: LfNav }) {
  const lf = useLf();
  const sh = useAdvShell();
  const cat = lf.catalog;
  const item = cat?.byName.get(name);
  const result = useMemo(() => {
    const props = item ? lf.propsOf(item) : { name, itemLevel: 80, stackSize: 1, quality: 0, identified: true, corrupted: false, mirrored: false, linkedSockets: 0, sockets: '', areaLevel: 83 };
    return lf.evaluate(props);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lf.evaluate, item, name]);
  const [showUnchecked, setShowUnchecked] = useState(false);
  const rules = lf.doc.rules;
  const decided = result?.decided ?? null;
  const rule = decided?.ruleId ? rules.find((r) => r.id === decided.ruleId) : undefined;
  const typeLabel = (t: string): string => cat?.types.find((x) => x.type === t)?.label ?? t;
  const blockName = (b: NonNullable<typeof decided>): string => {
    const r = b.ruleId ? rules.find((x) => x.id === b.ruleId) : undefined;
    if (r) return r.name ?? tr('lootfilter_advanced_shell_Explain.your_rule');
    if (b.tag) return tr('h_lootB_Explain.neversink_block', { type: typeLabel(b.tag.type), tier: cat?.tierByKey.get(tagKey(b.tag))?.label ?? b.tag.tier });
    return b.headerComment || tr('lootfilter_advanced_shell_Explain.block_at_line_line', { line: b.line });
  };
  const allSteps = (result?.steps ?? []).filter((s) => s.result !== 'miss');
  const unchecked = allSteps.filter((s) => s.result === 'unknown').length;
  const stack = showUnchecked ? allSteps : allSteps.filter((s) => s.result === 'match');
  const misses = (result?.steps ?? []).filter((s) => s.result === 'miss').length;
  const art = artFor(name);
  const head = !result
    ? tr('lootfilter_advanced_shell_Explain.the_filter_is_still_loading')
    : `${tr(result.visible ? 'h_lootB_Explain.head_shown' : 'h_lootB_Explain.head_hidden', { name })} ${decided ? (rule ? tr('h_lootB_Explain.decides_rule', { line: decided.line, rule: rule.name ?? tr('h_lootB_Explain.rule_word') }) : decided.tag ? tr('h_lootB_Explain.decides_neversink', { line: decided.line, what: `${typeLabel(decided.tag.type)} ${cat?.tierByKey.get(tagKey(decided.tag))?.label ?? ''}`.trimEnd() }) : tr('h_lootB_Explain.decides_plain', { line: decided.line })) : tr('lootfilter_advanced_shell_Explain_2.no_block_matches_so_the_game')}`;
  const bright = sh.ground === 'bright';
  return (
    <div className="adv-sh-explain" data-lg="panel" style={{ position: 'absolute', right }} role="dialog" aria-label={tr('lootfilter_advanced_shell_Explain.why_it_looks_like_this')}>
      <div style={{ padding: '12px 14px', display: 'flex', alignItems: 'center', gap: 8, borderBottom: '1px solid rgba(var(--line-rgb),.06)' }}>
        <span className="lf-eyebrow" style={{ flex: 1 }}>{tr('lootfilter_advanced_shell_Explain.why_it_looks_like_this_2')}</span>
        <button type="button" className="adv-sh-ib" title={tr('lootfilter_advanced_shell_Explain.close_esc')} aria-label={tr('lootfilter_advanced_shell_Explain.close')} onClick={onClose}>
          <Icon name="x" size={14} />
        </button>
      </div>
      <div className="lf-scroll" style={{ flex: 1, minHeight: 0, padding: 14, display: 'flex', flexDirection: 'column', gap: 12 }}>
        <span style={{ color: 'var(--text-strong)', fontSize: 15, lineHeight: 1.45, textWrap: 'pretty' }}>{head}</span>
        <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
          <div style={{ flex: 1, padding: '16px 14px', borderRadius: 10, background: groundFor(bright ? 'bright' : 'desert'), display: 'flex', justifyContent: 'center', minWidth: 0 }}>
            {result && <LabelChip name={name} style={result.style} hidden={!result.visible} hiddenLook="fade" bright={bright} />}
          </div>
          {art && <img src={art} alt="" width={64} height={64} style={{ flex: 'none', objectFit: 'contain', borderRadius: 8, background: 'rgba(var(--shadow-rgb),.35)' }} />}
        </div>
        <span style={{ color: 'var(--text-muted)', fontSize: 12 }}>{tr('lootfilter_advanced_shell_Explain.checked_as_one_drop_item')} {result?.uncertain ? tr('lootfilter_advanced_shell_Explain.some_blocks_test_things_this') : ''}</span>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6, minWidth: 0 }}>
          <span className="lf-eyebrow" style={{ fontSize: 10, letterSpacing: '.1em' }}>{tr('lootfilter_advanced_shell_Explain.rule_stack_top_to_bottom')}</span>
          {stack.length === 0 && <span style={{ color: 'var(--text-muted)', fontSize: 12.5 }}>{tr('lootfilter_advanced_shell_Explain.no_block_matched_this_item')}</span>}
          {stack.map((s, i) => {
            const b = s.block;
            const isD = decided === b;
            const unknown = s.result === 'unknown';
            const r = b.ruleId ? rules.find((x) => x.id === b.ruleId) : undefined;
            const tone = isD ? 'var(--gold-text)' : unknown ? 'var(--warning-text)' : 'var(--text-muted)';
            return (
              <div key={i} className="adv-sh-ex-row" style={{ borderColor: isD ? 'rgba(var(--accent-rgb),.45)' : 'rgba(var(--line-rgb),.08)', background: isD ? 'rgba(var(--accent-rgb),.07)' : 'rgba(var(--shadow-rgb),calc(.2*var(--shadow-k)))' }}>
                <span style={{ color: tone, font: '700 12px Geist', textAlign: 'center' }}>{i + 1}</span>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 3, minWidth: 0 }}>
                  <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap' }}>
                    <span style={{ color: isD ? 'var(--text-strong)' : 'var(--text-2)', fontWeight: 500, fontSize: 13 }}>{blockName(b)}</span>
                    <span style={{ font: "500 10.5px 'Geist Mono'", color: 'var(--text-faint)' }}>{tr('lootfilter_advanced_shell_Explain.line_line', { line: b.line })}</span>
                    <span style={{ font: '600 9.5px Geist', letterSpacing: '.08em', color: tone }}>{isD ? tr('lootfilter_advanced_shell_Explain.decides_touppercase', { kind: b.kind.toUpperCase() }) : unknown ? tr('lootfilter_advanced_shell_Explain.not_checked') : b.continue ? tr('lootfilter_advanced_shell_Explain.adds_to_the_look') : b.kind.toUpperCase()}</span>
                  </div>
                  <span style={{ color: 'var(--text-muted)', fontSize: 12, lineHeight: 1.45 }}>
                    {unknown ? tr('lootfilter_advanced_shell_Explain.tests_key_which_a_single', { key: s.failed?.key ?? 'something' }) : (r?.why ? lfBuild(r.why) : undefined) ?? (b.ruleId ? tr('lootfilter_advanced_shell_Explain.written_from_your_rules') : b.section ? tr('lootfilter_advanced_shell_Explain_2.neversink_section', { section: b.section }) : tr('lootfilter_advanced_shell_Explain_2.neversink_base_block'))}
                  </span>
                </div>
              </div>
            );
          })}
          {misses > 0 && <span style={{ color: 'var(--text-faint)', fontSize: 12 }}>{tr('lootfilter_advanced_shell_Explain.tolocalestring_blocks_above_did_not', { misses: misses.toLocaleString() })}</span>}
          {unchecked > 0 && (
            <button type="button" className="adv-sh-btn sm" style={{ alignSelf: 'flex-start' }} onClick={() => setShowUnchecked((v) => !v)}>
              {showUnchecked ? tr('lootfilter_advanced_shell_Explain.hide') : tr('lootfilter_advanced_shell_Explain.show')} {tr('lootfilter_advanced_shell_Explain.tolocalestring_blocks_a_single_drop', { unchecked: unchecked.toLocaleString() })}
            </button>
          )}
        </div>
      </div>
      <div style={{ padding: '12px 14px', borderTop: '1px solid rgba(var(--line-rgb),.06)', display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        {decided && (decided.ruleId || decided.tag) && (
          <button
            type="button"
            className="adv-sh-btn gold"
            onClick={() => {
              onClose();
              if (decided.ruleId) nav.openAdvanced('customize', { ruleId: decided.ruleId });
              else if (decided.tag) sh.goSection(decided.tag.type, tagKey(decided.tag));
            }}
          >
            <Icon name="list-ordered" size={14} />
            {tr('lootfilter_advanced_shell_Explain.jump_to_rule')}
          </button>
        )}
        {item && (
          <button
            type="button"
            className="adv-sh-btn"
            onClick={() => {
              onClose();
              sh.select({ kind: 'item', name });
              sh.openInspector('style');
            }}
          >
            <Icon name="edit" size={14} />
            {tr('lootfilter_advanced_shell_Explain.change_this_look')}
          </button>
        )}
        <span style={{ flex: 1 }} />
        <button type="button" className="adv-sh-btn" title={tr('lootfilter_advanced_shell_Explain.ask_is_not_connected_yet')} onClick={() => { onClose(); sh.openAsk(); }}>
          <Icon name="sparkle-fill" size={12} style={{ color: 'var(--gold-400)' }} />
          {tr('lootfilter_advanced_shell_Explain.ask_why')}
        </button>
      </div>
      {decided?.tag && <span className="sr-only">{tagLabel(decided.tag)}</span>}
    </div>
  );
}
