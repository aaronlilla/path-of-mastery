import type { Catalog, TierInfo } from './catalog.js';
import type { LabelStyle, Rule } from './types.js';
import { tagKey } from './blocks.js';
import { tierNames } from './tierNames.js';

/**
 * What a newer NeverSink release changes, found by comparing the item tables of two files built for the same
 * strictness: which items are new, which moved to another tier or are now hidden or shown, and which tiers got a
 * different look. Each change is checked against the player's rules: a change that touches an item or tier the
 * player already overrode is a conflict, which the player settles with "Keep mine" or "Take new".
 */

export type ChangeKind = 'new' | 'changed' | 'removed' | 'look';

export interface VersionChange {
  id: string;
  kind: ChangeKind;
  /** The item shown as a label. For a look change, a sample item of the tier. */
  item: string;
  /** The look the label is drawn with (the new one). */
  style: LabelStyle;
  hidden: boolean;
  what: string;
  why: string;
  type: string;
  /** The player's rules this change touches. Empty for a clean change. */
  rules: { id: string; name: string }[];
  /** Why it needs a choice, in plain words. */
  conflict?: string;
}

export interface VersionDiff {
  changes: VersionChange[];
  conflicts: VersionChange[];
  fresh: VersionChange[];
  changed: VersionChange[];
  /** Counts before any list is cut for display. */
  counts: { total: number; clean: number; conflicts: number; fresh: number; changed: number; removed: number };
}

const cap = (s: string): string => s;

function styleKeys(a: LabelStyle, b: LabelStyle): string[] {
  const out: string[] = [];
  const same = (x: unknown, y: unknown): boolean => JSON.stringify(x ?? null) === JSON.stringify(y ?? null);
  if (!same(a.fg, b.fg)) out.push('text colour');
  if (!same(a.bg, b.bg)) out.push('background');
  if (!same(a.bd, b.bd)) out.push('border');
  if (!same(a.fs, b.fs)) out.push('size');
  if (!same(a.sound, b.sound)) out.push('sound');
  if (!same(a.icon, b.icon)) out.push('map icon');
  if (!same(a.beam, b.beam)) out.push('beam');
  return out;
}

const join = (l: string[]): string => (l.length <= 1 ? l.join('') : `${l.slice(0, -1).join(', ')} and ${l[l.length - 1]}`);

function rulesFor(rules: Rule[], item: string | null, tierKeys: string[]): { id: string; name: string }[] {
  const out: { id: string; name: string }[] = [];
  for (const r of rules) {
    if (!r.enabled) continue;
    const hit = r.targets.some((t) => (t.tag && tierKeys.includes(tagKey(t.tag))) || (item !== null && (t.conditions ?? []).some((c) => c.key === 'BaseType' && c.values.includes(item))));
    if (hit) out.push({ id: r.id, name: r.name ?? 'Unnamed rule' });
  }
  return out;
}

export function diffVersions(oldCat: Catalog, newCat: Catalog, rules: Rule[], version: string, strictnessName: string): VersionDiff {
  const changes: VersionChange[] = [];
  const names = new Map<string, string>();
  for (const ty of newCat.types) for (const [k, v] of tierNames(ty.tiers)) names.set(k, v);
  for (const ty of oldCat.types) for (const [k, v] of tierNames(ty.tiers)) if (!names.has(k)) names.set(k, v);
  const tierName = (type: string, tier: string): string => names.get(`${type}|${tier}`) ?? tier;
  const typeLabel = (type: string): string => (newCat.types.find((t) => t.type === type) ?? oldCat.types.find((t) => t.type === type))?.label.split(/\s+-\s+|:\s/)[0]!.trim() ?? type;
  const lock = (n: string): string => n;

  for (const it of newCat.items) {
    const old = oldCat.byName.get(it.name);
    const key = (t: string, r: string): string => `${t}|${r}`;
    if (!old) {
      changes.push({
        id: `new:${it.name}`, kind: 'new', item: it.name, style: it.style, hidden: it.hidden,
        what: `${it.name} added to ${tierName(it.type, it.tier)} tier`, why: `New entry in ${typeLabel(it.type)}.`, type: it.type,
        rules: rulesFor(rules, it.name, [key(it.type, it.tier)].filter(() => false)),
      });
      continue;
    }
    if (old.type !== it.type || old.tier !== it.tier) {
      const from = tierName(old.type, old.tier);
      const to = tierName(it.type, it.tier);
      const moved = old.type === it.type ? `${it.name} moves from ${from} to ${to}` : `${it.name} moves from ${typeLabel(old.type)} ${from} to ${typeLabel(it.type)} ${to}`;
      changes.push({ id: `move:${it.name}`, kind: 'changed', item: it.name, style: it.style, hidden: it.hidden, what: moved, why: `NeverSink put it in a different tier in ${version}.`, type: it.type, rules: rulesFor(rules, it.name, []) });
    } else if (old.hidden !== it.hidden) {
      changes.push({ id: `hide:${it.name}`, kind: 'changed', item: it.name, style: it.style, hidden: it.hidden, what: it.hidden ? `${it.name} hides at ${strictnessName}` : `${it.name} shows at ${strictnessName}`, why: 'Strictness change.', type: it.type, rules: rulesFor(rules, it.name, []) });
    }
  }
  for (const it of oldCat.items) {
    if (newCat.byName.has(it.name)) continue;
    changes.push({ id: `gone:${it.name}`, kind: 'removed', item: it.name, style: it.style, hidden: it.hidden, what: `${it.name} is no longer listed`, why: `Not in NeverSink ${version}.`, type: it.type, rules: rulesFor(rules, it.name, []) });
  }
  // Tiers that look different. One row per item: a tier's sample is an item no other row already shows, and two
  // tiers that read the same ("Stacked Currencies B tier") are one row.
  const shown = new Set(changes.map((c) => c.item));
  const lookByWhat = new Map<string, VersionChange>();
  for (const ty of newCat.types) {
    for (const t of ty.tiers) {
      const o = oldCat.tierByKey.get(t.key);
      if (!o || t.kind === 'Hide' || o.kind === 'Hide') continue;
      const diff = styleKeys(o.style, t.style);
      if (!diff.length) continue;
      const what = `${typeLabel(t.type)} ${tierName(t.type, t.tier)} tier: ${join(diff)} changed`;
      const same = lookByWhat.get(what);
      if (same) {
        for (const r of rulesFor(rules, null, [t.key])) if (!same.rules.some((x) => x.id === r.id)) same.rules.push(r);
        same.id += `+${t.key}`;
        continue;
      }
      const sample = sampleOf(t, newCat, shown);
      const item = sample?.name ?? tierName(t.type, t.tier);
      shown.add(item);
      const ch: VersionChange = {
        id: `look:${t.key}`, kind: 'look', item, style: t.style, hidden: false,
        what, why: `NeverSink restyled this tier in ${version}.`, type: t.type,
        rules: rulesFor(rules, null, [t.key]),
      };
      lookByWhat.set(what, ch);
      changes.push(ch);
    }
  }
  // Your rules that name a tier the new file no longer has.
  const gone = new Set<string>();
  for (const ty of oldCat.types) for (const t of ty.tiers) if (!newCat.tierByKey.has(t.key)) gone.add(t.key);
  for (const r of rules) {
    if (!r.enabled) continue;
    for (const t of r.targets) {
      if (!t.tag || !gone.has(tagKey(t.tag))) continue;
      const sample = oldCat.tierByKey.get(tagKey(t.tag));
      changes.push({
        id: `tag:${r.id}:${tagKey(t.tag)}`, kind: 'removed', item: sample?.items[0] ?? r.name ?? 'Rule', style: r.style ?? sample?.style ?? {}, hidden: false,
        what: `${typeLabel(t.tag.type)} ${tierName(t.tag.type, t.tag.tier)} tier is gone`, why: `Your rule “${r.name ?? 'Unnamed rule'}” restyles it, so it would be left out of the file.`, type: t.tag.type, rules: [{ id: r.id, name: r.name ?? 'Unnamed rule' }],
        conflict: `Your rule “${r.name ?? 'Unnamed rule'}” restyles a tier that is gone in ${version}. Keep mine leaves it listed as needing review; Take new turns it off.`,
      });
    }
  }
  for (const c of changes) {
    if (c.rules.length && !c.conflict) {
      const n = c.rules[0]!.name;
      c.conflict = c.kind === 'look' ? `Your rule “${n}” restyles this tier, so your look stays unless you take the new one.` : `Your rule “${n}” covers this item, so your look stays unless you take the new one.`;
    }
  }
  void cap;
  void lock;
  const conflicts = changes.filter((c) => c.conflict);
  const clean = changes.filter((c) => !c.conflict);
  return {
    changes,
    conflicts,
    fresh: clean.filter((c) => c.kind === 'new'),
    changed: clean.filter((c) => c.kind !== 'new'),
    counts: { total: changes.length, clean: clean.length, conflicts: conflicts.length, fresh: clean.filter((c) => c.kind === 'new').length, changed: clean.filter((c) => c.kind !== 'new').length, removed: changes.filter((c) => c.kind === 'removed').length },
  };
}

function sampleOf(t: TierInfo, cat: Catalog, taken: Set<string>): { name: string } | undefined {
  for (const n of t.items) {
    const it = cat.byName.get(n);
    if (it && it.type === t.type && it.tier === t.tier && !taken.has(n)) return it;
  }
  const free = t.items.find((n) => !taken.has(n));
  return free ? { name: free } : undefined;
}
