// What the search palette finds in a build's text: its items, gems and configuration options. Pure, so it is tested.
import { readItems } from './itemsXml.js';
import { parseXml, type XmlNode } from './buildXml.js';
import type { ShowTarget } from './assistant/types.js';

export interface SearchRow {
  title: string;
  meta: string;
  extra?: string;
  /** Where picking the row goes: the tab and the thing on it to ring (same shape the assistant's show uses). */
  target?: ShowTarget;
}


const kids = (n: XmlNode | undefined, tag: string) => n?.children.filter((c) => c.tag === tag) ?? [];

/** The name an item text carries: the line after "Rarity:" (magic items have only the base line). */
export function itemNameOf(text: string): string {
  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
  const first = lines[0] ?? '';
  const afterRarity = /^Rarity:/i.test(first) ? lines.slice(1) : lines;
  const name = (afterRarity[0] ?? '').replace(/^\{[^}]*\}/, '');
  return name.replace(/\{[^}]*\}/g, '').trim();
}

export function itemRows(xml: string): SearchRow[] {
  const m = readItems(xml);
  const set = m.sets.find((s) => s.id === m.activeSet) ?? m.sets[0];
  if (!set) return [];
  const out: SearchRow[] = [];
  for (const [slot, ref] of set.slots) {
    if (!ref.itemId) continue;
    const it = m.items.find((x) => x.id === ref.itemId);
    if (!it) continue;
    const title = itemNameOf(it.text);
    if (title) out.push({ title, meta: slot, target: { tab: 'items', slot } });
  }
  return out;
}

export function gemRows(xml: string): SearchRow[] {
  let root: XmlNode;
  try {
    root = parseXml(xml);
  } catch {
    return [];
  }
  const skills = kids(root, 'Skills')[0];
  if (!skills) return [];
  const sets = kids(skills, 'SkillSet');
  const active = skills.attrs.activeSkillSet ?? '1';
  const scope = sets.length ? (sets.find((s) => (s.attrs.id ?? '1') === active) ?? sets[0]!) : skills;
  const seen = new Set<string>();
  const out: SearchRow[] = [];
  for (const [gi, g] of kids(scope, 'Skill').entries()) {
    for (const [ki, gem] of kids(g, 'Gem').entries()) {
      const name = gem.attrs.nameSpec ?? '';
      if (!name || seen.has(name)) continue;
      seen.add(name);
      const support = /^Support/.test(gem.attrs.skillId ?? '') || / Support$/.test(name);
      const lv = gem.attrs.level;
      const q = gem.attrs.quality;
      out.push({ title: name, meta: `${support ? 'Support' : 'Active'}${lv ? ` · ${lv}/${q ?? 0}` : ''}`, target: { tab: 'skills', gem: { group: gi + 1, gem: ki + 1 } } });
    }
  }
  return out;
}

export interface CfgOpt {
  var: string;
  label: string;
  section: string;
  type: string;
  list?: Array<{ val: string; label: string }>;
}

/** Every configuration option by its label; an option the build has changed shows its value, the others their section. */
export function configRows(xml: string, OPTIONS: CfgOpt[]): SearchRow[] {
  const set = new Map<string, string>();
  try {
    const cfg = kids(parseXml(xml), 'Config')[0];
    const sets = kids(cfg, 'ConfigSet');
    const activeId = cfg?.attrs.activeConfigSet ?? '1';
    const scope = sets.length ? (sets.find((s) => (s.attrs.id ?? '1') === activeId) ?? sets[0]!) : cfg;
    for (const i of kids(scope, 'Input')) {
      const v = i.attrs.boolean !== undefined ? (i.attrs.boolean === 'true' ? 'On' : 'Off') : (i.attrs.number ?? i.attrs.string);
      if (i.attrs.name && v !== undefined) set.set(i.attrs.name, v);
    }
  } catch {
    // no readable configuration: every option shows its section
  }
  return OPTIONS.filter((o) => o.type !== 'text' && o.label).map((o) => {
    const raw = set.get(o.var);
    const shown = raw === undefined ? undefined : (o.list?.find((l) => l.val === raw)?.label ?? raw);
    return { title: o.label.replace(/:\s*$/, '').replace(/\^\d|\^x[0-9a-f]{6}/gi, ''), meta: shown ?? o.section, target: { tab: 'config', configKey: o.var } };
  });
}

