import type { LabelStyle, Rule, TagRef } from '../../../../shared/lootfilter/types.js';
import type { Catalog, CatalogItem, TierInfo } from '../../../../shared/lootfilter/catalog.js';
import { blockStyle, tagKey } from '../../../../shared/lootfilter/blocks.js';
import { mergeStyle } from '../../../../shared/lootfilter/generate.js';
import type { LfValue } from '../../lfStore';
import type { Selection } from './selection';
import { tr } from '../../../i18n';

/**
 * Advanced edits as rules. A tier restyle is one Advanced rule that targets the tier's tag. A single item is one
 * Advanced rule with a `BaseType == "name"` condition above NeverSink. Moving an item to a tier is that same item
 * rule with `styleFrom` set to the tier, so the tier an item sits in is always readable from the rules.
 */

export const tagOf = (t: { type: string; tier: string }): TagRef => ({ type: t.type, tier: t.tier });
const sameTag = (a: TagRef | undefined, b: TagRef | undefined): boolean => !!a && !!b && a.type === b.type && a.tier === b.tier;

export function isItemRule(r: Rule, name?: string): boolean {
  if (r.source !== 'advanced' || r.targets.length !== 1) return false;
  const c = r.targets[0]!.conditions;
  if (!c || c.length !== 1 || c[0]!.key !== 'BaseType' || c[0]!.values.length !== 1) return false;
  return name === undefined || c[0]!.values[0] === name;
}

export function itemRule(rules: Rule[], name: string): Rule | undefined {
  return rules.find((r) => isItemRule(r, name));
}

export function tierRule(rules: Rule[], tag: TagRef): Rule | undefined {
  return rules.find((r) => r.source === 'advanced' && r.targets.length === 1 && !r.targets[0]!.conditions && sameTag(r.targets[0]!.tag, tag));
}

const isEmptyRule = (r: Rule): boolean => !r.visibility && !r.styleFrom && (!r.style || Object.keys(r.style).length === 0);

/** The visibility the rules give a tier (highest priority wins; a reset puts it back). undefined means NeverSink decides. */
export function tagVisibility(rules: Rule[], tag: TagRef): 'show' | 'hide' | undefined {
  let v: 'show' | 'hide' | undefined;
  for (const r of [...rules].filter((x) => x.enabled).sort((a, b) => a.priority - b.priority)) {
    if (!r.targets.some((t) => sameTag(t.tag, tag))) continue;
    if (r.reset) v = undefined;
    else if (r.visibility) v = r.visibility;
  }
  return v;
}

export function tierHidden(rules: Rule[], tier: TierInfo): boolean {
  const v = tagVisibility(rules, tagOf(tier));
  return v ? v === 'hide' : tier.kind === 'Hide';
}

// ---- tiers the player added -------------------------------------------------------------------

/** The base type names a tier the player added holds. */
export function customNames(r: Rule): string[] {
  return r.targets.flatMap((t) => t.conditions ?? []).filter((c) => c.key === 'BaseType').flatMap((c) => c.values);
}

export const customKey = (r: Rule): string => `custom:${r.id}`;

/** Tiers the player added to the sections that hold these NeverSink types, oldest first. */
export function customTierRules(rules: Rule[], types: string[]): Rule[] {
  return rules.filter((r) => r.customTier && types.includes(r.customTier.type)).sort((a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0) || a.priority - b.priority);
}

/** The added tier an item is in, if any. */
export function customTierOfItem(rules: Rule[], name: string): Rule | undefined {
  return rules.find((r) => r.enabled && r.customTier && customNames(r).includes(name));
}

function withNames(r: Rule, names: string[]): Partial<Rule> {
  return { targets: [{ conditions: names.length ? [{ key: 'BaseType', op: '==', values: names }] : [] }] };
}

/** Adds an empty tier to a section. It writes nothing until an item is moved into it. */
export function addCustomTier(lf: LfValue, type: string, name: string, style: LabelStyle): Rule {
  const rule: Rule = { id: lf.newId('ct'), name, source: 'advanced', enabled: true, priority: lf.nextPriority(), targets: [{ conditions: [] }], visibility: 'show', customTier: { type }, style, createdAt: Date.now() };
  lf.addRule(rule, tr('lootfilter_advanced_shell_edits.added_name', { name }));
  return rule;
}

/** Takes an item out of every tier the player added. */
export function removeFromCustomTiers(lf: LfValue, name: string): void {
  for (const r of lf.doc.rules) {
    if (!r.customTier) continue;
    const have = customNames(r);
    if (have.includes(name)) lf.updateRule(r.id, withNames(r, have.filter((n) => n !== name)), tr('lootfilter_advanced_shell_edits.took_name_out_of_name2', { name, name2: r.name ?? 'a tier' }));
  }
}

/** Moves an item into a tier the player added: it leaves its own rule and any other added tier. */
export function moveItemToCustomTier(lf: LfValue, it: CatalogItem, tier: Rule): string {
  const label = tr('lootfilter_advanced_shell_edits.moved_name_to_name2', { name: it.name, name2: tier.name ?? 'a tier' });
  const have = customNames(tier);
  if (have.includes(it.name)) return label;
  const own = itemRule(lf.doc.rules, it.name);
  if (own) lf.removeRule(own.id, label);
  removeFromCustomTiers(lf, it.name);
  lf.updateRule(tier.id, { ...withNames(tier, [...have, it.name]), enabled: true }, label);
  return label;
}

/** The tier key an item sits in: where NeverSink puts it, unless one of your rules moved it. */
export function tierKeyOfItem(rules: Rule[], it: CatalogItem): string {
  const ct = customTierOfItem(rules, it.name);
  if (ct) return customKey(ct);
  const r = itemRule(rules, it.name);
  if (r?.styleFrom && r.enabled) return tagKey(r.styleFrom);
  return tagKey({ type: it.type, tier: it.tier });
}

function applyPatch(style: LabelStyle | undefined, patch: Partial<LabelStyle>): LabelStyle {
  const next: Record<string, unknown> = { ...(style ?? {}) };
  for (const k of Object.keys(patch) as (keyof LabelStyle)[]) {
    if (patch[k] === undefined) delete next[k];
    else next[k] = patch[k];
  }
  return next as LabelStyle;
}

// ---- looks -------------------------------------------------------------------------------------

export type LookTarget = { kind: 'item'; item: CatalogItem } | { kind: 'tier'; tier: TierInfo } | { kind: 'rule'; rule: Rule };

export function resolveTarget(lf: LfValue, sel: Selection | null): LookTarget | null {
  const cat = lf.catalog;
  if (!sel) return null;
  if (sel.kind === 'item') {
    const item = cat?.byName.get(sel.name);
    return item ? { kind: 'item', item } : null;
  }
  if (sel.kind === 'tier') {
    const tier = cat?.tierByKey.get(sel.key);
    return tier ? { kind: 'tier', tier } : null;
  }
  const rule = lf.doc.rules.find((r) => r.id === sel.id);
  return rule ? { kind: 'rule', rule } : null;
}

/** The look as it lands in the written filter. */
export function currentLook(lf: LfValue, t: LookTarget): LabelStyle {
  const cat = lf.catalog;
  if (t.kind === 'item') {
    const r = lf.evaluateCatalogItem(t.item);
    return r && Object.keys(r.style).length ? r.style : t.item.style;
  }
  if (t.kind === 'tier') {
    const key = tagKey(tagOf(t.tier));
    const b = lf.genBlocks.find((x) => x.tag && tagKey(x.tag) === key && x.kind !== 'Hide');
    return b ? blockStyle(b) : t.tier.style;
  }
  const from = t.rule.styleFrom && cat ? cat.tierByKey.get(tagKey(t.rule.styleFrom))?.style : undefined;
  return mergeStyle(from ?? {}, t.rule.style);
}

/** The look NeverSink alone gives (no rules). */
export function baseLook(t: LookTarget): LabelStyle {
  if (t.kind === 'item') return t.item.style;
  if (t.kind === 'tier') return t.tier.style;
  return t.rule.style ?? {};
}

export function targetName(t: LookTarget, cat: Catalog | null): string {
  if (t.kind === 'item') return t.item.name;
  if (t.kind === 'tier') return `${cat?.types.find((x) => x.type === t.tier.type)?.label ?? t.tier.type}, ${t.tier.label}`;
  return t.rule.name ?? tr('lootfilter_advanced_shell_edits_2.rule');
}

/** Applies a look change. Undefined fields in `patch` are cleared (back to what NeverSink has). */
export function writeLook(lf: LfValue, t: LookTarget, patch: Partial<LabelStyle>, label: string): void {
  const rules = lf.doc.rules;
  if (t.kind === 'rule') {
    lf.updateRule(t.rule.id, { style: applyPatch(t.rule.style, patch) }, label);
    return;
  }
  if (t.kind === 'tier') {
    const tag = tagOf(t.tier);
    const cur = tierRule(rules, tag);
    if (cur) {
      lf.updateRule(cur.id, { style: applyPatch(cur.style, patch), enabled: true }, label);
      return;
    }
    lf.addRule(
      { id: lf.newId('t'), name: tr('lootfilter_advanced_shell_edits_2.look_of', { label: t.tier.label }), source: 'advanced', enabled: true, priority: lf.nextPriority(), targets: [{ tag }], style: applyPatch(undefined, patch), createdAt: Date.now() },
      label,
    );
    return;
  }
  const it = t.item;
  const cur = itemRule(rules, it.name);
  if (cur) {
    lf.updateRule(cur.id, { style: applyPatch(cur.style, patch), enabled: true }, label);
    return;
  }
  const r = lf.evaluateCatalogItem(it);
  const base = r && r.visible && Object.keys(r.style).length ? r.style : tierStyleOf(lf, it);
  lf.addRule(
    {
      id: lf.newId('i'),
      name: it.name,
      source: 'advanced',
      enabled: true,
      priority: lf.nextPriority(),
      targets: [{ conditions: [{ key: 'BaseType', op: '==', values: [it.name] }] }],
      visibility: 'show',
      style: applyPatch(base, patch),
      createdAt: Date.now(),
    },
    label,
  );
}

function tierStyleOf(lf: LfValue, it: CatalogItem): LabelStyle {
  const t = lf.catalog?.tierByKey.get(tagKey({ type: it.type, tier: it.tier }));
  return t && Object.keys(t.style).length ? t.style : it.style;
}

/** Puts a tier, an item or a rule's look back to NeverSink's. */
export function resetTarget(lf: LfValue, t: LookTarget, label: string): void {
  const rules = lf.doc.rules;
  if (t.kind === 'rule') {
    lf.updateRule(t.rule.id, { style: undefined as unknown as LabelStyle }, label);
    return;
  }
  if (t.kind === 'tier') {
    const cur = tierRule(rules, tagOf(t.tier));
    if (cur) lf.removeRule(cur.id, label);
    return;
  }
  const cur = itemRule(rules, t.item.name);
  if (cur) lf.removeRule(cur.id, label);
}

// ---- hide and show --------------------------------------------------------------------------------

/** The nearest tier of the same type that NeverSink shows, to borrow a look when a hidden tier is turned on. */
function visibleSibling(cat: Catalog | null, tier: TierInfo): TierInfo | undefined {
  const type = cat?.types.find((x) => x.type === tier.type);
  if (!type) return undefined;
  const i = type.tiers.findIndex((x) => x.key === tier.key);
  const order = [...type.tiers.slice(0, i).reverse(), ...type.tiers.slice(i + 1)];
  return order.find((x) => x.kind !== 'Hide' && Object.keys(x.style).length > 0);
}

export function setTierHidden(lf: LfValue, tier: TierInfo, hide: boolean): string {
  const tag = tagOf(tier);
  const cur = tierRule(lf.doc.rules, tag);
  const baseHide = tier.kind === 'Hide';
  const visibility = hide === baseHide ? undefined : hide ? 'hide' : 'show';
  const label = tr(hide ? 'h_lootB_Edits.hid_name' : 'h_lootB_Edits.showed_name', { name: tier.label });
  const borrow = !hide && baseHide ? visibleSibling(lf.catalog, tier) : undefined;
  if (cur) {
    const next: Rule = { ...cur, enabled: true };
    if (visibility) next.visibility = visibility;
    else delete next.visibility;
    if (borrow && !cur.style?.fg && !cur.styleFrom) next.styleFrom = tagOf(borrow);
    if (!visibility && cur.styleFrom && !cur.style) delete next.styleFrom;
    if (isEmptyRule(next)) lf.removeRule(cur.id, label);
    else lf.updateRule(cur.id, next, label);
    return label;
  }
  if (!visibility) return label;
  lf.addRule(
    {
      id: lf.newId('t'),
      name: `${hide ? 'Hide' : 'Show'} ${tier.label}`,
      source: 'advanced',
      enabled: true,
      priority: lf.nextPriority(),
      targets: [{ tag }],
      visibility,
      ...(borrow ? { styleFrom: tagOf(borrow) } : {}),
      createdAt: Date.now(),
    },
    label,
  );
  return label;
}

export function setItemHiddenRule(lf: LfValue, it: CatalogItem, hide: boolean): string {
  const cur = itemRule(lf.doc.rules, it.name);
  const label = tr(hide ? 'h_lootB_Edits.hid_name' : 'h_lootB_Edits.showed_name', { name: it.name });
  const baseHide = it.hidden;
  const visibility = hide === baseHide ? undefined : hide ? 'hide' : 'show';
  if (cur) {
    const next: Rule = { ...cur, enabled: true };
    if (visibility) next.visibility = visibility;
    else delete next.visibility;
    if (!hide && !next.style && !next.styleFrom && baseHide) next.style = tierStyleOf(lf, it);
    if (isEmptyRule(next)) lf.removeRule(cur.id, label);
    else lf.updateRule(cur.id, next, label);
    return label;
  }
  if (!visibility) return label;
  lf.addRule(
    {
      id: lf.newId('i'),
      name: it.name,
      source: 'advanced',
      enabled: true,
      priority: lf.nextPriority(),
      targets: [{ conditions: [{ key: 'BaseType', op: '==', values: [it.name] }] }],
      visibility,
      ...(!hide ? { style: tierStyleOf(lf, it) } : {}),
      createdAt: Date.now(),
    },
    label,
  );
  return label;
}

/** Moves an item to a tier: it gets that tier's look and visibility. Dropping it back in its own tier removes the rule. */
export function moveItemToTier(lf: LfValue, it: CatalogItem, tier: TierInfo): string {
  removeFromCustomTiers(lf, it.name);
  const cur = itemRule(lf.doc.rules, it.name);
  const toHidden = tierHidden(lf.doc.rules, tier);
  const home = tier.type === it.type && tier.tier === it.tier;
  const label = tr('lootfilter_advanced_shell_edits.moved_name_to_label', { name: it.name, label: tier.label });
  if (home && toHidden === it.hidden) {
    if (cur) lf.removeRule(cur.id, label);
    return label;
  }
  const fields: Partial<Rule> = { visibility: toHidden ? 'hide' : 'show', styleFrom: tagOf(tier), enabled: true };
  if (cur) {
    const next: Rule = { ...cur, ...fields };
    delete next.style;
    lf.updateRule(cur.id, next, label);
    return label;
  }
  lf.addRule(
    {
      id: lf.newId('i'),
      name: it.name,
      source: 'advanced',
      enabled: true,
      priority: lf.nextPriority(),
      targets: [{ conditions: [{ key: 'BaseType', op: '==', values: [it.name] }] }],
      visibility: toHidden ? 'hide' : 'show',
      styleFrom: tagOf(tier),
      createdAt: Date.now(),
    },
    label,
  );
  return label;
}

// ---- counts ---------------------------------------------------------------------------------------

/** The catalog types a rule touches: by tag, or by the base types its conditions name. */
export function typesOfRule(r: Rule, cat: Catalog): Set<string> {
  const out = new Set<string>();
  if (r.customTier) out.add(r.customTier.type);
  for (const t of r.targets) {
    if (t.tag) out.add(t.tag.type);
    for (const c of t.conditions ?? []) {
      if (c.key !== 'BaseType') continue;
      for (const v of c.values) {
        const it = cat.byName.get(v);
        if (it) out.add(it.type);
      }
    }
  }
  return out;
}

/** True when every target of the rule sits inside one catalog type. */
export function onlyType(r: Rule, cat: Catalog, type: string | string[]): boolean {
  const types = Array.isArray(type) ? type : [type];
  if (r.customTier) return types.includes(r.customTier.type);
  if (!r.targets.length) return false;
  return r.targets.every((t) => {
    if (t.tag) return types.includes(t.tag.type);
    const names = (t.conditions ?? []).filter((c) => c.key === 'BaseType').flatMap((c) => c.values);
    if (!names.length || (t.conditions ?? []).some((c) => c.key !== 'BaseType')) return false;
    return names.every((n) => types.includes(cat.byName.get(n)?.type ?? ''));
  });
}

export function agoText(ms: number): string {
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (s < 60) return tr('lootfilter_advanced_shell_edits_2.just_now');
  const m = Math.round(s / 60);
  if (m < 60) return tr('lootfilter_advanced_shell_edits.m_min_ago', { value: m });
  const h = Math.round(m / 60);
  if (h < 48) return tr('lootfilter_advanced_shell_edits.h_hr_ago', { h });
  return tr('lootfilter_advanced_shell_edits.v1_days_ago', { value: Math.round(h / 24) });
}
