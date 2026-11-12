import type { Catalog, CatalogItem, TierInfo } from './catalog.js';
import type { Clause, Condition, GuidedAction, GuidedMeta, LabelStyle, Rule, TagRef, Target } from './types.js';
import { GEAR_KINDS } from './bases.js';
import { tagKey } from './blocks.js';

/**
 * Guided mode's plain-words model and how it turns into rule data. A Guided change is "these items and tiers,
 * except these, should be hidden / quiet / stand out / loud / back to normal / look like another tier".
 * `compileGuided` turns it into the same `Rule` fields Advanced edits.
 */

export interface GuidedSection {
  id: string;
  name: string;
  sub: string;
  /** `$type` values whose tiers and items belong here. The first is the main tier list. */
  types: string[];
  /** Art name for the section tile (looked up by artFor). */
  art: string;
}

export const GUIDED_SECTIONS: GuidedSection[] = [
  { id: 'currency', name: 'Currency', sub: 'Orbs, scrolls and shards', types: ['currency'], art: 'Chaos Orb' },
  { id: 'cards', name: 'Divination cards', sub: 'Stackable card drops', types: ['divination'], art: 'The Doctor' },
  { id: 'uniques', name: 'Uniques', sub: 'By base type', types: ['uniques'], art: 'Mageblood' },
  { id: 'maps', name: 'Maps', sub: 'By map tier', types: ['maps', 'fragments->scarabs', 'fragments'], art: 'Cartographer’s Chisel' },
  { id: 'gems', name: 'Gems', sub: 'Exceptional gems', types: ['gems->exceptional', 'gems->special', 'gems->generic'], art: 'Enlighten Support' },
  { id: 'gear', name: 'Gear', sub: 'Rarity, kind, level, links', types: [], art: 'Stygian Vise' },
];

export function sectionOfType(type: string): GuidedSection | undefined {
  return GUIDED_SECTIONS.find((s) => s.types.includes(type)) ?? (type.startsWith('currency') ? GUIDED_SECTIONS[0] : undefined);
}

export function tiersOfSection(cat: Catalog, sec: GuidedSection): TierInfo[] {
  const main = cat.types.find((t) => t.type === sec.types[0]);
  return main ? main.tiers : [];
}

export function itemsOfSection(cat: Catalog, sec: GuidedSection): CatalogItem[] {
  return cat.items.filter((i) => sec.types.includes(i.type) || (sec.id === 'currency' && i.type.startsWith('currency')) || (sec.id === 'gems' && i.type.startsWith('gems')));
}

// ---- looks -------------------------------------------------------------------------------------

/** Fallback looks when a change spans sections. Same colours the design uses. */
export const PRESET_LOOKS: Record<'loud' | 'standout' | 'quiet', LabelStyle> = {
  loud: { fg: [190, 20, 20], bg: [255, 255, 255, 255], bd: [190, 20, 20], fs: 42, sound: { kind: 'builtin', id: 6, vol: 250 }, beam: { colour: 'Red' }, icon: { size: 0, colour: 'Red', shape: 'Star' } },
  standout: { fg: [0, 0, 0], bg: [249, 150, 25, 255], bd: [0, 0, 0], fs: 38, sound: null, beam: null, icon: { size: 1, colour: 'Orange', shape: 'Diamond' } },
  quiet: { fg: [140, 140, 140], bg: [0, 0, 0, 140], bd: [0, 0, 0, 0], fs: 20, sound: null, beam: null, icon: null },
};

/** The look a change gives, for previews. Mirrors what `compileGuided` writes. */
export function guidedLook(g: GuidedMeta, cat: Catalog | null): LabelStyle | null {
  if (g.act === 'hide' || g.act === 'reset') return null;
  if (g.act === 'custom') return g.look ?? PRESET_LOOKS.standout;
  if (g.act === 'match' && g.match && cat) return cat.tierByKey.get(tagKey(g.match))?.style ?? null;
  const pre = g.act === 'loud' || g.act === 'standout' || g.act === 'quiet' ? PRESET_LOOKS[g.act] : null;
  if (!pre) return null;
  const ref = sectionTier(g, cat);
  if (ref && cat) {
    const s = cat.tierByKey.get(tagKey(ref.tag))?.style;
    if (s) return g.act === 'standout' ? { ...s, sound: null, beam: null, icon: s.icon ?? PRESET_LOOKS.standout.icon } : s;
  }
  return pre;
}

/** When every pick sits in one section, loud means that section's top tier and stand out its second. */
function sectionTier(g: GuidedMeta, cat: Catalog | null): { tag: TagRef } | null {
  if (!cat || (g.act !== 'loud' && g.act !== 'standout')) return null;
  const secs = new Set<string>();
  for (const c of g.sel) {
    if (c.t === 'gear') return null;
    if (c.t === 'item') {
      const it = cat.byName.get(c.name);
      const s = it ? sectionOfType(it.type) : undefined;
      if (!s) return null;
      secs.add(s.id);
    } else {
      const s = sectionOfType(c.type);
      if (!s) return null;
      secs.add(s.id);
    }
  }
  if (secs.size !== 1) return null;
  const sec = GUIDED_SECTIONS.find((s) => s.id === [...secs][0])!;
  const shown = tiersOfSection(cat, sec).filter((t) => t.kind !== 'Hide' && !t.conditional && Object.keys(t.style).length > 0);
  const pick = g.act === 'loud' ? shown[0] : shown[1] ?? shown[0];
  return pick ? { tag: { type: pick.type, tier: pick.tier } } : null;
}

// ---- clauses -> rule fields ----------------------------------------------------------------------

export function gearConditions(c: Extract<Clause, { t: 'gear' }>): Condition[] {
  const out: Condition[] = [];
  const classes = Object.keys(c.cls).flatMap((id) => GEAR_KINDS.find((k) => k.id === id)?.classes ?? [id]);
  if (classes.length) out.push({ key: 'Class', op: '==', values: classes });
  const rar = ['normal', 'magic', 'rare'].filter((r) => c.rar[r]).map((r) => r[0]!.toUpperCase() + r.slice(1));
  if (rar.length) out.push({ key: 'Rarity', op: '', values: rar });
  if (c.il > 1) out.push({ key: 'ItemLevel', op: '>=', values: [String(c.il)] });
  if (c.lk > 0) out.push({ key: 'LinkedSockets', op: '>=', values: [String(c.lk)] });
  if (c.q) out.push({ key: 'Quality', op: '>=', values: [String(c.q)] });
  if (c.sk) out.push({ key: 'Sockets', op: '>=', values: [String(c.sk)] });
  if (c.cor) out.push({ key: 'Corrupted', op: '', values: [c.cor === 'yes' ? 'True' : 'False'] });
  if (c.idn) out.push({ key: 'Identified', op: '', values: [c.idn === 'yes' ? 'True' : 'False'] });
  if (c.inf) out.push({ key: 'HasInfluence', op: '', values: ['Shaper', 'Elder', 'Crusader', 'Hunter', 'Redeemer', 'Warlord'] });
  return out;
}

function tagBlocksConditions(cat: Catalog | null, tag: TagRef): Condition[][] {
  if (!cat) return [];
  return cat.blocks.filter((b) => b.tag && tagKey(b.tag) === tagKey(tag)).map((b) => b.conditions);
}

function clauseTargets(cs: Clause[], cat: Catalog | null): Target[] {
  const out: Target[] = [];
  const names = cs.filter((c): c is Extract<Clause, { t: 'item' }> => c.t === 'item').map((c) => c.name);
  if (names.length) out.push({ conditions: [{ key: 'BaseType', op: '==', values: names }] });
  for (const c of cs) {
    if (c.t === 'tier') out.push({ tag: { type: c.type, tier: c.tier } });
    else if (c.t === 'sec') {
      const sec = GUIDED_SECTIONS.find((s) => s.types[0] === c.type);
      const tiers = cat && sec ? tiersOfSection(cat, sec) : cat?.types.find((t) => t.type === c.type)?.tiers ?? [];
      for (const t of tiers) out.push({ tag: { type: t.type, tier: t.tier } });
    } else if (c.t === 'gear') out.push({ conditions: gearConditions(c) });
  }
  return out;
}

function clauseExceptions(cs: Clause[], cat: Catalog | null): Condition[][] {
  const out: Condition[][] = [];
  const names = cs.filter((c): c is Extract<Clause, { t: 'item' }> => c.t === 'item').map((c) => c.name);
  if (names.length) out.push([{ key: 'BaseType', op: '==', values: names }]);
  for (const c of cs) {
    if (c.t === 'gear') out.push(gearConditions(c));
    else if (c.t === 'tier') out.push(...tagBlocksConditions(cat, { type: c.type, tier: c.tier }));
    else if (c.t === 'sec') {
      const sec = GUIDED_SECTIONS.find((s) => s.types[0] === c.type);
      for (const t of cat && sec ? tiersOfSection(cat, sec) : []) out.push(...tagBlocksConditions(cat, { type: t.type, tier: t.tier }));
    }
  }
  return out;
}

export type GuidedFields = Pick<Rule, 'targets' | 'except' | 'visibility' | 'style' | 'styleFrom' | 'reset'>;

/** The rule fields for a Guided change. The catalog is needed for loud and stand out (section looks) and tier exceptions. */
export function compileGuided(g: GuidedMeta, cat: Catalog | null): GuidedFields {
  const targets = clauseTargets(g.sel, cat);
  const exc = clauseExceptions(g.exc, cat);
  const out: GuidedFields = { targets };
  if (exc.length) out.except = exc;
  switch (g.act) {
    case 'hide':
      out.visibility = 'hide';
      break;
    case 'reset':
      out.reset = true;
      break;
    case 'match':
      out.visibility = 'show';
      if (g.match) out.styleFrom = g.match;
      break;
    case 'custom':
      out.visibility = 'show';
      out.style = g.look ?? PRESET_LOOKS.standout;
      break;
    case 'loud':
    case 'standout':
    case 'quiet': {
      out.visibility = 'show';
      const ref = sectionTier(g, cat);
      if (ref) {
        out.styleFrom = ref.tag;
        // Stand out: the section's second tier look without sound or beam, and always with a minimap icon.
        if (g.act === 'standout') out.style = { sound: null, beam: null, ...(cat?.tierByKey.get(tagKey(ref.tag))?.style.icon ? {} : { icon: PRESET_LOOKS.standout.icon }) };
      } else out.style = PRESET_LOOKS[g.act];
      break;
    }
  }
  return out;
}

// ---- words -------------------------------------------------------------------------------------

const cap = (s: string): string => (s ? s[0]!.toUpperCase() + s.slice(1) : s);

export function clauseLabel(c: Clause, cat: Catalog | null): string {
  switch (c.t) {
    case 'item':
      return c.name;
    case 'tier': {
      const t = cat?.tierByKey.get(`${c.type}|${c.tier}`);
      const sec = sectionOfType(c.type);
      return `${sec?.name ?? c.label ?? c.type} · ${t?.label ?? c.label ?? c.tier}`;
    }
    case 'sec': {
      const sec = GUIDED_SECTIONS.find((s) => s.types[0] === c.type);
      return `All ${(sec?.name ?? c.label ?? c.type).toLowerCase()}`;
    }
    case 'gear': {
      const rs = ['normal', 'magic', 'rare'].filter((k) => c.rar[k]).map((k) => ({ normal: 'white', magic: 'blue', rare: 'yellow' })[k]).join(' and ');
      const cs = Object.keys(c.cls).map((id) => (GEAR_KINDS.find((k) => k.id === id)?.label ?? id).toLowerCase()).join(' and ') || 'gear';
      let s = (rs ? rs + ' ' : '') + cs;
      const cd: string[] = [];
      if (c.il > 1) cd.push(`item level ${c.il} or more`);
      if (c.lk > 0) cd.push(`${c.lk} or more linked sockets`);
      if (c.sk) cd.push(`${c.sk} or more sockets`);
      if (c.q) cd.push(`quality ${c.q}% or more`);
      if (c.cor) cd.push(c.cor === 'yes' ? 'corrupted' : 'not corrupted');
      if (c.idn) cd.push(c.idn === 'yes' ? 'identified' : 'unidentified');
      if (c.inf) cd.push('an influence');
      if (cd.length) s += ' with ' + cd.join(' and ');
      return cap(s);
    }
  }
}

export const VERB: Record<GuidedAction, string> = {
  hide: 'Hide',
  quiet: 'Make small and quiet',
  standout: 'Make stand out',
  loud: 'Make loud',
  custom: 'Restyle',
  reset: 'Put back to normal',
  match: 'Match another tier',
};

export function joinWords(a: string[]): string {
  return a.length < 2 ? a.join('') : a.slice(0, -1).join(', ') + ' and ' + a[a.length - 1];
}
/** Up to three names, then "and N more". */
export function joinMax3(a: string[]): string {
  return a.length > 3 ? a.slice(0, 3).join(', ') + ' and ' + (a.length - 3) + ' more' : joinWords(a);
}

export function guidedRest(g: GuidedMeta, cat: Catalog | null): string {
  return joinMax3(g.sel.map((c) => clauseLabel(c, cat))) + (g.exc.length ? ', except ' + joinMax3(g.exc.map((c) => clauseLabel(c, cat))) : '') + '.';
}

export function guidedSentence(g: GuidedMeta, cat: Catalog | null): string {
  return `${VERB[g.act]}: ${guidedRest(g, cat)}`;
}

/** Catalog items a change picks, for counts and previews. Gear clauses select by rule, not by item, so they are not counted. */
export function selectItems(cat: Catalog, sel: Clause[], exc: Clause[]): CatalogItem[] {
  const matches = (c: Clause, it: CatalogItem): boolean => {
    if (c.t === 'item') return it.name === c.name;
    if (c.t === 'tier') return it.type === c.type && it.tier === c.tier;
    if (c.t === 'sec') {
      const sec = GUIDED_SECTIONS.find((s) => s.types[0] === c.type);
      return sec ? sectionOfType(it.type)?.id === sec.id : it.type === c.type;
    }
    return false;
  };
  return cat.items.filter((it) => sel.some((c) => matches(c, it)) && !exc.some((c) => matches(c, it)));
}

export function newGuidedRule(id: string, g: GuidedMeta, cat: Catalog | null, priority: number, now: number): Rule {
  const f = compileGuided(g, cat);
  return {
    id,
    name: guidedSentence(g, cat),
    source: 'guided',
    enabled: true,
    priority,
    guided: g,
    createdAt: now,
    ...f,
  };
}
