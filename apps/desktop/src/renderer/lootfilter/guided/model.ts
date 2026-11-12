import type { Catalog, CatalogItem } from '../../../shared/lootfilter/catalog.js';
import type { Clause, GuidedAction, LabelStyle, TagRef } from '../../../shared/lootfilter/types.js';
import { GEAR_KINDS } from '../../../shared/lootfilter/bases.js';
import { GUIDED_SECTIONS, clauseLabel, sectionOfType, tiersOfSection, type GuidedSection } from '../../../shared/lootfilter/guided.js';
import { tr } from '../../i18n';
import { gsecName, gsecSub } from '../names';

/** The wizard's working state. It is saved with the filter so a reload keeps the change in progress. */
export interface Wiz {
  step: 1 | 2 | 3;
  editId: string | null;
  sel: Clause[];
  exc: Clause[];
  mode: 'add' | 'except';
  /** 'home' shows the category tiles; a section id shows its tiers and items; 'gear' the gear builder. */
  pick: string;
  q: string;
  act: GuidedAction | null;
  cust: boolean;
  look: LabelStyle | null;
  match: TagRef | null;
  gb: { rar: Record<string, 1>; cls: Record<string, 1>; il: number; lk: number; more: boolean; q: number; sk: number; cor?: 'yes' | 'no'; idn?: 'yes' | 'no'; inf: boolean };
}

export const W0 = (): Wiz => ({ step: 1, editId: null, sel: [], exc: [], mode: 'add', pick: 'home', q: '', act: null, cust: false, look: null, match: null, gb: { rar: {}, cls: {}, il: 1, lk: 0, more: false, q: 0, sk: 0, inf: false } });

export const ckey = (c: Clause): string => JSON.stringify(c);

/** Words people type, mapped to the item names NeverSink and the game use. */
export const ALIAS: Record<string, string> = {
  div: 'Divine Orb', divs: 'Divine Orb', divine: 'Divine Orb', ex: 'Exalted Orb', exa: 'Exalted Orb', exalt: 'Exalted Orb', chaos: 'Chaos Orb',
  alch: 'Orb of Alchemy', alchs: 'Orb of Alchemy', fuse: 'Orb of Fusing', fus: 'Orb of Fusing', chrome: 'Chromatic Orb', chrom: 'Chromatic Orb',
  alt: tr('lootfilter_guided_model.orb_of_alteration'), alts: 'Orb of Alteration', annul: 'Orb of Annulment', gcp: "Gemcutter's Prism", portal: 'Portal Scroll',
  wisdom: 'Scroll of Wisdom', wis: 'Scroll of Wisdom', transmute: 'Orb of Transmutation', mirror: 'Mirror of Kalandra', vaal: 'Vaal Orb', regal: 'Regal Orb', jeweller: "Jeweller's Orb",
};

export const GEAR_SYNONYMS: [string, string, { rar?: Record<string, 1>; lk?: number; cls?: string }][] = [
  ['white whites normal', 'White gear', { rar: { normal: 1 } }],
  ['blue magic blues', 'Blue gear', { rar: { magic: 1 } }],
  ['yellow rare rares', 'Yellow gear', { rar: { rare: 1 } }],
  ['links linked 4l 5l', '4 or more linked sockets', { lk: 4 }],
  ['6l six 6 links', '6 linked sockets', { lk: 6 }],
];

export interface Row {
  clause: Clause;
  kind: 'ALL' | 'TIER' | 'ITEM' | 'GEAR';
  text: string;
  sub: string;
  item?: CatalogItem;
}

export function sectionItems(cat: Catalog, sec: GuidedSection): CatalogItem[] {
  return cat.items.filter((i) => sectionOfType(i.type)?.id === sec.id);
}

export function gearClause(rar: Record<string, 1>, cls: Record<string, 1>, il = 1, lk = 0): Clause {
  return { t: 'gear', rar, cls, il, lk };
}

const strip = (t: string): string => (t.length > 3 && t.endsWith('s') ? t.slice(0, -1) : t);

export function searchRows(cat: Catalog, q: string, priceOf: (n: string) => number | undefined): Row[] {
  const toks = q.toLowerCase().split(/\s+/).filter(Boolean);
  if (!toks.length) return [];
  const rows: Row[] = [];
  const hit = (text: string): boolean => toks.every((t) => text.includes(t) || text.includes(strip(t)));
  for (const sec of GUIDED_SECTIONS) {
    if (sec.id === 'gear') continue;
    const t = `all ${sec.name.toLowerCase()} ${sec.id}`;
    if (hit(t)) rows.push({ clause: { t: 'sec', type: sec.types[0]!, label: sec.name }, kind: 'ALL', text: tr('lootfilter_guided_model.all_tolowercase', { name: gsecName(sec).toLowerCase() }), sub: gsecSub(sec) });
    for (const tier of tiersOfSection(cat, sec)) {
      const tt = `tier ${tier.number} t${tier.number} ${sec.name.toLowerCase()} ${tier.label.toLowerCase()}`;
      if (hit(tt)) rows.push({ clause: { t: 'tier', type: tier.type, tier: tier.tier }, kind: 'TIER', text: `${gsecName(sec)} · ${tier.label}`, sub: tr('lootfilter_guided_model.length_item_types', { count: tier.items.length }) });
    }
  }
  const aliasHit = new Set(toks.map((t) => ALIAS[t]).filter(Boolean) as string[]);
  const items: Row[] = [];
  for (const it of cat.items) {
    const sec = sectionOfType(it.type);
    if (!sec) continue;
    const name = it.name.toLowerCase();
    if (aliasHit.has(it.name) || hit(name)) items.push({ clause: { t: 'item', name: it.name }, kind: 'ITEM', text: it.name, sub: gsecName(sec), item: it });
  }
  items.sort((a, b) => {
    const rank = (r: Row): number => (aliasHit.has(r.text) ? 0 : r.text.toLowerCase() === q.toLowerCase() ? 0 : r.text.toLowerCase().startsWith(toks[0]!) ? 1 : 2);
    const pa = rank(a);
    const pb = rank(b);
    return pa - pb || (priceOf(b.text) ?? 0) - (priceOf(a.text) ?? 0) || a.text.localeCompare(b.text);
  });
  rows.push(...items.slice(0, 60));
  for (const [words, label, g] of GEAR_SYNONYMS) if (hit(words + ' gear')) rows.push({ clause: gearClause(g.rar ?? {}, {}, 1, g.lk ?? 0), kind: 'GEAR', text: label, sub: tr('lootfilter_guided_model.a_rule_for_gear_not') });
  for (const k of GEAR_KINDS) if (hit(k.label.toLowerCase() + 's ' + k.label.toLowerCase())) rows.push({ clause: gearClause({}, { [k.id]: 1 }), kind: 'GEAR', text: k.label, sub: tr('lootfilter_guided_model.a_rule_for_gear_not') });
  return rows;
}

export function didYouMean(cat: Catalog, q: string): CatalogItem | null {
  const q3 = q.trim().toLowerCase().slice(0, 3);
  if (q3.length < 3) return null;
  return cat.items.find((i) => sectionOfType(i.type) && i.name.toLowerCase().split(' ').some((w) => w.startsWith(q3))) ?? null;
}

export function clauseSummary(cs: Clause[], cat: Catalog | null): string[] {
  return cs.map((c) => clauseLabel(c, cat));
}
