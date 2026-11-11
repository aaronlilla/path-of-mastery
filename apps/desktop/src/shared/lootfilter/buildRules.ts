import type { Catalog } from './catalog.js';
import type { Condition, LabelStyle, Rule } from './types.js';
import { GEAR_KINDS } from './bases.js';
import { parseXml, type XmlNode } from '../buildXml.js';

/**
 * "Loot filter for this build": proposals derived from the open build's equipped items and skills.
 * Nothing is invented: every proposal names the item or gem it comes from, and the player applies them.
 */

export interface BuildItemFact {
  slot: string;
  rarity: string;
  name: string;
  base: string;
  itemLevel?: number;
}

export interface BuildFacts {
  className: string;
  ascendancy: string;
  level: number;
  mainSkill: string;
  items: BuildItemFact[];
  gems: { name: string; support: boolean; main: boolean }[];
}

const SLOT_CLASSES: Record<string, string[]> = {
  'Weapon 1': [],
  'Weapon 2': [],
  Helmet: ['Helmets'],
  'Body Armour': ['Body Armours'],
  Gloves: ['Gloves'],
  Boots: ['Boots'],
  Belt: ['Belts'],
  Amulet: ['Amulets'],
  'Ring 1': ['Rings'],
  'Ring 2': ['Rings'],
};

function find(n: XmlNode, tag: string, out: XmlNode[] = []): XmlNode[] {
  if (n.tag === tag) out.push(n);
  for (const c of n.children) find(c, tag, out);
  return out;
}

let supportNames: Set<string> = new Set();
/** The engine's support gem names (without " Support"). Build files from older versions carry no skill id, so the name decides. */
export function setSupportGemNames(names: Iterable<string>): void {
  supportNames = new Set(names);
}

export function readBuildFacts(xml: string): BuildFacts | null {
  let root: XmlNode;
  try {
    root = parseXml(xml);
  } catch {
    return null;
  }
  const build = find(root, 'Build')[0];
  if (!build) return null;
  const itemsById = new Map<string, BuildItemFact & { raw: string }>();
  for (const it of find(root, 'Item')) {
    const lines = it.text.split('\n').map((l) => l.trim()).filter(Boolean);
    const rar = /^Rarity:\s*(\w+)/i.exec(lines[0] ?? '');
    if (!rar) continue;
    const rarity = rar[1]!.toUpperCase();
    const name = lines[1] ?? '';
    // Unique and rare items list the name, then the base. Normal items list only the base. Magic names embed it.
    const base = rarity === 'UNIQUE' || rarity === 'RARE' ? lines[2] ?? '' : rarity === 'NORMAL' ? name.replace(/^Superior /, '') : '';
    const il = /^Item Level:\s*(\d+)/m.exec(it.text);
    itemsById.set(it.attrs.id ?? '', { slot: '', rarity, name, base, ...(il ? { itemLevel: Number(il[1]) } : {}), raw: it.text });
  }
  const items: BuildItemFact[] = [];
  const activeSet = find(root, 'ItemSet')[0];
  const slots = find(activeSet ?? root, 'Slot');
  const seen = new Set<string>();
  for (const s of slots) {
    const name = s.attrs.name ?? '';
    const id = s.attrs.itemId ?? '';
    if (!(name in SLOT_CLASSES) && !/^Weapon/.test(name)) continue;
    const it = itemsById.get(id);
    if (!it || !it.base || seen.has(name)) continue;
    seen.add(name);
    items.push({ slot: name, rarity: it.rarity, name: it.name, base: it.base, ...(it.itemLevel ? { itemLevel: it.itemLevel } : {}) });
  }
  const groups = find(root, 'Skill');
  const mainIdx = Number(build.attrs.mainSocketGroup ?? '1') - 1;
  const gems: BuildFacts['gems'] = [];
  groups.forEach((g, gi) => {
    if (g.attrs.enabled === 'false') return;
    for (const gem of g.children.filter((c) => c.tag === 'Gem')) {
      if (gem.attrs.enabled === 'false') continue;
      const nm = gem.attrs.nameSpec ?? '';
      if (!nm) continue;
      const support = /^Support/.test(gem.attrs.skillId ?? '') || / Support$/.test(nm) || supportNames.has(nm);
      if (!gems.some((x) => x.name === nm)) gems.push({ name: nm, support, main: gi === mainIdx });
    }
  });
  const main = gems.find((g) => g.main && !g.support);
  return {
    className: build.attrs.className ?? '',
    ascendancy: build.attrs.ascendClassName ?? '',
    level: Number(build.attrs.level ?? '1') || 1,
    mainSkill: main?.name ?? '',
    items,
    gems,
  };
}

/** The name the game shows for a gem item (what BaseType matches). */
export function gemItemName(name: string, support: boolean): string {
  return support && !/ Support$/.test(name) ? `${name} Support` : name;
}

export const BUILD_LOOK: LabelStyle = { fg: [255, 255, 255], bg: [16, 40, 28, 235], bd: [62, 224, 106], fs: 34, sound: null, beam: null, icon: { size: 1, colour: 'Green', shape: 'Circle' } };
const GEM_LOOK: LabelStyle = { ...BUILD_LOOK, fs: 32 };
const UPGRADE_LOOK: LabelStyle = { fg: [255, 255, 255], bg: [25, 80, 55, 255], bd: [90, 220, 150], fs: 42, sound: { kind: 'builtin', id: 9, vol: 250 }, beam: { colour: 'Green', temp: true }, icon: { size: 0, colour: 'Green', shape: 'Kite' } };

export interface BuildProposal {
  id: string;
  /** Short label for lists. */
  title: string;
  why: string;
  rule: Rule;
}

const mk = (id: string, title: string, why: string, conditions: Condition[], style: LabelStyle, priority: number): BuildProposal => ({
  id,
  title,
  why,
  rule: { id, name: title, source: 'build', enabled: true, priority, targets: [{ conditions }], visibility: 'show', style, why },
});

/** Rules for the build: its gear bases, upgrades at item level 83, and its gems. Ids are stable so a re-read keeps the player's toggles. */
export function proposalsFor(facts: BuildFacts, cat: Catalog | null, firstPriority = 1): BuildProposal[] {
  const out: BuildProposal[] = [];
  let p = firstPriority;
  const bases = new Set<string>();
  for (const it of facts.items) {
    if (!it.base || bases.has(it.base)) continue;
    bases.add(it.base);
    out.push(mk(`build:base:${it.base}`, `${it.base}`, `Your ${it.slot.toLowerCase()} is a ${it.base}${it.name && it.name !== it.base ? ` (${it.name})` : ''}.`, [{ key: 'BaseType', op: '==', values: [it.base] }, { key: 'Rarity', op: '', values: ['Normal', 'Magic', 'Rare'] }], BUILD_LOOK, p++));
    if (it.slot !== 'Belt' && it.slot !== 'Amulet' && !/^Ring/.test(it.slot)) {
      out.push(mk(`build:up:${it.base}`, `${it.base}, item level 83 or more`, `Item level 83 or more lets this base roll the top tier mods your ${it.slot.toLowerCase()} would want.`, [{ key: 'BaseType', op: '==', values: [it.base] }, { key: 'Rarity', op: '', values: ['Rare'] }, { key: 'ItemLevel', op: '>=', values: ['83'] }], UPGRADE_LOOK, p++));
    }
  }
  const classOfGem = (g: { support: boolean }): string => (g.support ? 'Support Gems' : 'Skill Gems');
  for (const g of facts.gems) {
    out.push(mk(`build:gem:${g.name}`, g.name, g.main && !g.support ? 'Your main skill. Pick it up to level or quality it.' : g.support ? `A support gem in your skills.` : 'A skill gem in your build.', [{ key: 'Class', op: '==', values: [classOfGem(g)] }, { key: 'BaseType', op: '==', values: [gemItemName(g.name, g.support)] }], GEM_LOOK, p++));
  }
  return out;
}

export interface ResistAffix {
  element: 'Fire' | 'Cold' | 'Lightning';
  /** The suffix name the game shows, like "of Haast". */
  affix: string;
  /** Item level the affix starts to drop at. */
  level: number;
  min: number;
  max: number;
}

const RESIST_CLASSES = ['Rings', 'Amulets', 'Belts', 'Gloves', 'Boots', 'Helmets', 'Body Armours', 'Shields'];

/**
 * Rules from the build's own numbers: for each element the build is under the 75% cap by, show rare gear that
 * can roll a resistance suffix big enough to close the gap. `stats` are the engine's `Missing<Element>Resist`
 * values; the affixes come from the engine's item data (suffixes of that element, with their roll ranges).
 */
export function proposalsFromStats(stats: Record<string, number | string | boolean | null>, affixes: ResistAffix[], firstPriority = 1): BuildProposal[] {
  const out: BuildProposal[] = [];
  let p = firstPriority;
  for (const el of ['Fire', 'Cold', 'Lightning'] as const) {
    const missing = stats[`Missing${el}Resist`];
    if (typeof missing !== 'number' || missing < 1) continue;
    const mine = affixes.filter((a) => a.element === el).sort((a, b) => a.level - b.level);
    if (!mine.length) continue;
    const need = Math.ceil(missing);
    let fit = mine.filter((a) => a.max >= need);
    if (!fit.length) fit = [mine[mine.length - 1]!];
    const names = [...new Set(fit.map((a) => a.affix))];
    const il = Math.min(...fit.map((a) => a.level));
    out.push(
      mk(
        `build:res:${el}`,
        `${el} resistance gear`,
        `Your ${el.toLowerCase()} resistance is ${need}% under the cap. Rare gear with ${fit[0]!.affix}${fit.length > 1 ? ' or better' : ''} (up to ${fit[fit.length - 1]!.max}%) can close it.`,
        [{ key: 'Class', op: '==', values: RESIST_CLASSES }, { key: 'Rarity', op: '', values: ['Rare'] }, { key: 'ItemLevel', op: '>=', values: [String(il)] }, { key: 'HasExplicitMod', op: '', values: ['>=1', ...names] }],
        UPGRADE_LOOK,
        p++,
      ),
    );
  }
  return out;
}

/** The "What do you use?" chips when there is no build: highlight those gear kinds. */
export function proposalsForUse(use: string[], firstPriority = 1): BuildProposal[] {
  let p = firstPriority;
  const out: BuildProposal[] = [];
  for (const id of use) {
    const k = GEAR_KINDS.find((x) => x.id === id);
    if (!k) continue;
    out.push(mk(`build:use:${id}`, `${k.label} you use`, `You said you use ${k.label.toLowerCase()}.`, [{ key: 'Class', op: '==', values: k.classes }, { key: 'Rarity', op: '', values: ['Normal', 'Magic', 'Rare'] }, { key: 'ItemLevel', op: '>=', values: ['60'] }], BUILD_LOOK, p++));
  }
  return out;
}

/** Replaces the rules the build wrote earlier, keeping the player's on/off choices for ids that survive. */
export function mergeBuildRules(existing: Rule[], proposals: BuildProposal[], now = Date.now()): Rule[] {
  const old = new Map(existing.filter((r) => r.source === 'build').map((r) => [r.id, r]));
  const mine = proposals.map((p) => ({ ...p.rule, enabled: old.get(p.id)?.enabled ?? true, createdAt: old.get(p.id)?.createdAt ?? now }));
  return [...existing.filter((r) => r.source !== 'build'), ...mine];
}
