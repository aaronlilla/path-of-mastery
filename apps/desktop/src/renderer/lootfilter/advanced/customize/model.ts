import type { Catalog, TypeInfo } from '../../../../shared/lootfilter/catalog.js';
import { conditionToLine, tagKey } from '../../../../shared/lootfilter/blocks.js';
import { guidedSentence } from '../../../../shared/lootfilter/guided.js';
import type { Condition, Rule } from '../../../../shared/lootfilter/types.js';
import { customNames, isItemRule, typesOfRule } from '../shell/edits';
import { GROUP_ORDER, SECTIONS, sectionOfType, type SectionDef } from '../../../../shared/lootfilter/sections.js';
import { tr } from '../../../i18n';

export interface SectionNode {
  def: SectionDef;
  /** The NeverSink `$type` tags that sit in this section, in file order. */
  types: TypeInfo[];
}

export interface TreeGroup {
  name: string;
  sections: SectionNode[];
}

/** The groups and sections of the design, filled from NeverSink's `$type` tags. A section with no tags of its own is left out unless it points at another one. */
export function buildTree(cat: Catalog): TreeGroup[] {
  const byId = new Map<string, TypeInfo[]>();
  const sorted = cat.types.map((t, i) => ({ t, i })).sort((a, b) => a.t.toc - b.t.toc || a.i - b.i).map((e) => e.t);
  for (const t of sorted) {
    const id = sectionOfType(t.type).id;
    const l = byId.get(id);
    if (l) l.push(t);
    else byId.set(id, [t]);
  }
  // Inside a section the types follow the order the section lists them in, then the file order.
  for (const [id, l] of byId) {
    const def = SECTIONS.find((d) => d.id === id)!;
    const rank = (t: TypeInfo): number => {
      const i = def.types.findIndex((p) => (typeof p === 'string' ? p === t.type : p.test(t.type)));
      return i < 0 ? 999 : i;
    };
    byId.set(id, l.map((t, i) => ({ t, i })).sort((a, b) => rank(a.t) - rank(b.t) || a.i - b.i).map((e) => e.t));
  }
  return GROUP_ORDER.map((name) => ({
    name,
    sections: SECTIONS.filter((d) => d.group === name)
      .map((def) => ({ def, types: byId.get(def.id) ?? [] }))
      .filter((n) => n.types.length > 0 || n.def.seeInstead),
  })).filter((g) => g.sections.length > 0 || g.name === 'Your build');
}

/** The section a NeverSink type, or a section id, points at. */
export function findSection(tree: TreeGroup[], idOrType: string): SectionNode | undefined {
  for (const g of tree) for (const s of g.sections) if (s.def.id === idOrType || s.types.some((t) => t.type === idOrType)) return s;
  return undefined;
}

/** How many of your rules touch each section, and how many of those come from the build. */
export function ruleCounts(rules: Rule[], cat: Catalog): Map<string, { mod: number; build: number }> {
  const m = new Map<string, { mod: number; build: number }>();
  for (const r of rules) {
    if (!r.enabled) continue;
    for (const t of typesOfRule(r, cat)) {
      const e = m.get(t) ?? { mod: 0, build: 0 };
      e.mod++;
      if (r.source === 'build') e.build++;
      m.set(t, e);
    }
  }
  return m;
}

export const SOURCE: Record<Rule['source'], { label: string; colour: string }> = {
  guided: { label: tr('lootfilter_advanced_customize_model.you'), colour: 'var(--gold-text)' },
  advanced: { label: tr('lootfilter_advanced_customize_model.you'), colour: 'var(--gold-text)' },
  build: { label: tr('lootfilter_advanced_customize_model.build_plan'), colour: 'var(--positive-text)' },
  price: { label: tr('lootfilter_advanced_customize_model.prices'), colour: 'var(--info)' },
};

const condText = (cs: Condition[]): string =>
  cs
    .map((c) => conditionToLine(c).replace(/\s+/g, ' '))
    .join(', ')
    .slice(0, 140);

/** A rule in words, for the list. */
export function ruleText(r: Rule, cat: Catalog | null): string {
  if (r.customTier) {
    const n = customNames(r).length;
    return `${r.name ?? tr('lootfilter_advanced_customize_model_2.added_tier')}: ${n === 0 ? tr('lootfilter_advanced_customize_model_2.no_items_yet') : tr('lootfilter_advanced_customize_TierList.count_items', { count: n })}`;
  }
  if (r.guided) return guidedSentence(r.guided, cat);
  const tierName = (t: { type: string; tier: string }): string => {
    const ti = cat?.tierByKey.get(tagKey(t));
    const ty = cat?.types.find((x) => x.type === t.type);
    return `${ty?.label ?? t.type}, ${ti?.label ?? t.tier}`;
  };
  const hasStyle = !!r.style && Object.keys(r.style).length > 0;
  if (isItemRule(r)) {
    const name = r.targets[0]!.conditions![0]!.values[0]!;
    if (r.styleFrom) return tr(r.visibility === 'hide' ? 'h_lootB_Model.move_to_hidden' : 'h_lootB_Model.move_to', { name, tier: tierName(r.styleFrom) });
    if (r.visibility === 'hide') return tr('lootfilter_advanced_customize_model.hide_name', { name });
    return hasStyle ? tr('lootfilter_advanced_customize_model.change_the_look_of_name', { name }) : tr('lootfilter_advanced_customize_model.show_name', { name });
  }
  if (r.targets.length === 1 && r.targets[0]!.tag && !r.targets[0]!.conditions && !r.except?.length) {
    const t = tierName(r.targets[0]!.tag);
    if (r.reset) return tr('lootfilter_advanced_customize_model.put_t_back_to_neversink', { value: t });
    if (r.visibility === 'hide') return tr('lootfilter_advanced_customize_model.hide_t', { value: t });
    if (r.visibility === 'show') return tr('lootfilter_advanced_customize_model.show_t', { value: t });
    return tr('lootfilter_advanced_customize_model.change_the_look_of_t', { value: t });
  }
  const verb = r.visibility === 'hide' ? tr('lootfilter_advanced_customize_model_2.hide') : r.visibility === 'show' ? tr('lootfilter_advanced_customize_model_2.show') : r.reset ? tr('lootfilter_advanced_customize_model.put_back_to_neversink') : tr('lootfilter_advanced_customize_model_2.restyle');
  const parts = r.targets.map((t) => (t.tag ? tierName(t.tag) : condText(t.conditions ?? []) || tr('h_lootB_Model.everything_w')));
  const except = r.except?.length ? `, ${tr('h_lootB_Model.except_w', { what: r.except.map(condText).join(` ${tr('h_lootB_Model.or_w')} `) })}` : '';
  return `${verb} ${parts.join(` ${tr('h_lootB_Model.and_w')} `) || tr('h_lootB_Model.nothing_w')}${except}`;
}
