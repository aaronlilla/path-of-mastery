import type { FilterSetup, LabelStyle, Rule } from '../../../../shared/lootfilter/types.js';
import type { LfProposal } from '../../../../shared/lootfilter/ipcTypes.js';
import { tagKey } from '../../../../shared/lootfilter/blocks.js';
import { mergeStyle } from '../../../../shared/lootfilter/generate.js';
import { conflictFor } from '../../../../shared/lootfilter/review.js';
import { yourRulesView } from '../../../../shared/lootfilter/yourRules.js';
import { formatPrice, itemPrice, type LfValue } from '../../lfStore';
import type { LookState, Proposal, ProposedChange } from '../diffStore';
import { tr } from '../../../i18n';
import { lfText } from '../../mainText';

/**
 * Turns a list of proposed rules into the rows of the review panel: a before and an after label for a sample item,
 * how many item types it touches, a warning when it hides something worth more than the player's value line, and a
 * note when one of the player's rules already above it keeps winning. Nothing here changes the filter.
 */

const NO_SOCKETS = /Ring|Amulet|Belt|Jewel|Flask|Currency|Card|Gem|Map|Fragment|Scarab|Essence|Fossil|Resonator|Oil|Delirium|Incubator|Contract|Blueprint|Tincture|Quiver|Splinter|Catalyst|Tattoo|Omen/i;

/** The item a row shows a label for: the first item the rule names, or the first of its tier or section. */
export function sampleName(lf: LfValue, rule: Rule, sample?: string[]): string {
  if (sample?.[0]) return sample[0];
  for (const t of rule.targets) {
    const bt = t.conditions?.find((c) => c.key === 'BaseType');
    if (bt?.values[0]) return bt.values[0];
    if (t.tag) {
      const first = lf.catalog?.tierByKey.get(tagKey(t.tag))?.items[0];
      if (first) return first;
    }
  }
  return rule.name ?? tr('lootfilter_advanced_review_build_2.item');
}

export function currentLook(lf: LfValue, name: string): LookState {
  const it = lf.catalog?.byName.get(name);
  if (!it) return { name, style: {} };
  const r = lf.evaluateCatalogItem(it);
  return { name, style: r?.style ?? it.style, ...(r && !r.visible ? { hidden: true, tag: tr('lootfilter_advanced_review_build_2.hidden') } : {}) };
}

export function afterLook(lf: LfValue, rule: Rule, before: LookState): LookState {
  if (rule.visibility === 'hide') return { name: before.name, style: before.style, hidden: true, tag: tr('lootfilter_advanced_review_build_2.hidden') };
  let style: LabelStyle = before.style;
  if (rule.reset) style = lf.catalog?.byName.get(before.name)?.style ?? style;
  if (rule.styleFrom) style = mergeStyle(style, lf.catalog?.tierByKey.get(tagKey(rule.styleFrom))?.style);
  return { name: before.name, style: mergeStyle(style, rule.style) };
}

function namesOf(rule: Rule): string[] {
  return rule.targets.flatMap((t) => (t.conditions ?? []).filter((c) => c.key === 'BaseType' && c.op !== '!' && c.op !== '!=').flatMap((c) => c.values));
}

/** What would be hidden that is worth more than the player's value line, in words. Empty when nothing is. */
export function valueWarning(lf: LfValue, rule: Rule): string | undefined {
  if (rule.visibility !== 'hide' || !lf.settings.confirmValuable || !lf.prices) return undefined;
  const line = 1;
  const dear = namesOf(rule)
    .map((n) => ({ n, p: itemPrice(lf.prices, n)?.chaos, via: itemPrice(lf.prices, n)?.via }))
    .filter((x): x is { n: string; p: number; via: string | undefined } => x.p !== undefined && x.p >= line)
    .sort((a, b) => b.p - a.p)[0];
  if (!dear) return undefined;
  const fmt = (c: number): string => formatPrice(c, lf.prices?.divine ?? 0, lf.settings.currencyUnit);
  return dear.via ? tr('h_lootB_Review.warn_via', { name: dear.n, via: dear.via, price: fmt(dear.p), line: fmt(line) }) : tr('h_lootB_Review.warn_plain', { name: dear.n, price: fmt(dear.p), line: fmt(line) });
}

/** The note for a rule that an earlier rule of the player's partly or fully overrides. */
export function conflictNote(lf: LfValue, rule: Rule): string | undefined {
  if (!lf.gen) return undefined;
  const view = yourRulesView(lf.gen.text, lf.gen.baseStartLine, lf.doc.name);
  const existing = lf.genBlocks.filter((b) => b.ruleId && b.line < lf.gen!.baseStartLine && lf.doc.rules.some((r) => r.id === b.ruleId && r.enabled));
  const byId = new Map(lf.doc.rules.map((r) => [r.id, r]));
  const socketable = (r: Rule): boolean => {
    const cls = r.targets.flatMap((t) => (t.conditions ?? []).filter((c) => c.key === 'Class').flatMap((c) => c.values));
    if (cls.length) return !cls.every((c) => NO_SOCKETS.test(c));
    const names = namesOf(r);
    if (!names.length) return true;
    return names.some((n) => {
      const c = lf.catalog?.byName.get(n)?.class ?? lf.engineBases?.bases.find((b) => b.name === n)?.class ?? '';
      return !c || !NO_SOCKETS.test(c);
    });
  };
  const c = conflictFor(
    existing,
    rule,
    (b) => view.fromFile(b.line) ?? b.line,
    (b) => byId.get(b.ruleId ?? '')?.name ?? b.headerComment.replace(/^#\s*/, ''),
    (b) => (byId.get(b.ruleId ?? '')?.source === 'build' ? 'build' : ''),
    socketable,
    (n) => lf.catalog?.byName.get(n)?.class ?? lf.engineBases?.bases.find((b) => b.name === n)?.class,
  );
  return c ? lfText(c.text) : undefined;
}

const ACTION_GROUP: Record<string, string> = { hide: tr('lootfilter_advanced_review_build_2.hidden'), quiet: tr('lootfilter_advanced_review_build_2.quieter'), standout: tr('lootfilter_advanced_review_build.stand_out'), loud: tr('lootfilter_advanced_review_build_2.loud'), reset: tr('lootfilter_advanced_review_build_2.back_to_neversink'), match: tr('lootfilter_advanced_review_build.look_copied'), custom: tr('lootfilter_advanced_review_build.changed_look') };

/** The rows for an assistant proposal. */
export function proposalFromLf(lf: LfValue, p: LfProposal, request?: string): Proposal {
  const changes: ProposedChange[] = p.changes.map((c, i) => {
    const group = c.section ?? (c.guided ? ACTION_GROUP[c.guided.act] : undefined) ?? tr('lootfilter_advanced_review_build_2.changes');
    const base = { id: `${p.id}:${i}`, group, what: c.sentence.replace(/\.$/, ''), ...(c.reason ? { why: c.reason } : {}), ...(c.setup ? { setup: c.setup } : {}), status: 'pending' as const };
    // A change that only moves a setting (the Build Filter's overrides, the leveling skill) has no rule and no label to compare.
    if (!c.rule) return { ...base, before: { name: c.sample[0] ?? '', style: {} }, after: { name: c.sample[0] ?? '', style: {} }, affected: c.itemCount };
    const before = currentLook(lf, sampleName(lf, c.rule, c.sample));
    const flag = valueWarning(lf, c.rule);
    const conflict = conflictNote(lf, c.rule);
    return { ...base, before, after: afterLook(lf, c.rule, before), affected: c.itemCount, rule: c.rule, ...(flag ? { flag } : {}), ...(conflict ? { conflict } : {}) };
  });
  return { id: p.id, source: 'Ask', title: request || p.title, changes, createdAt: p.createdAt };
}

/**
 * Adds the ticked changes to the player's rules in one undo step. New rules go below every rule already there,
 * so what the player set up before keeps winning, and a setup change (like strictness) is applied with them.
 */
export function applyChanges(lf: LfValue, list: ProposedChange[], label: string): void {
  if (!list.length) return;
  const rules = list.filter((c): c is ProposedChange & { rule: Rule } => !!c.rule);
  const setup = list.reduce<Partial<FilterSetup>>((acc, c) => ({ ...acc, ...(c.setup ?? {}) }), {});
  const lowest = Math.min(0, ...lf.doc.rules.map((r) => r.priority));
  const now = Date.now();
  const made: Rule[] = rules.map((c, i) => ({ ...c.rule, id: lf.newId('g'), priority: lowest - 1 - i, createdAt: now }));
  lf.edit(label, (d) => ({ ...d, setup: { ...d.setup, ...setup }, rules: [...d.rules, ...made] }));
}
