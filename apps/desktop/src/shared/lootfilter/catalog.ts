import type { Block, BlockKind, LabelStyle, TagRef } from './types.js';
import { blockStyle, tagKey } from './blocks.js';
import { evaluateItem, type ItemProps } from './evaluate.js';
import { sectionOfType } from './sections.js';
import { cleanWords, describeTier } from './tierDescribe.js';

/**
 * A readable map of a NeverSink file: its types and tiers (from the `$type` and `$tier` tags), the item names
 * each tier lists, and where every item lands. Built from the blocks, so it always matches the bundled base.
 */

export interface TierInfo {
  key: string;
  type: string;
  tier: string;
  /** 1-based position among the tiers of this type, in file order. */
  number: number;
  label: string;
  kind: BlockKind;
  style: LabelStyle;
  /** Exact BaseType names across this tier's blocks. */
  items: string[];
  /** Header lines of the blocks that carry this tag. */
  lines: number[];
  section: string;
  /** True when the tier's blocks have conditions beyond Class and BaseType (level, quality, mods...). */
  conditional: boolean;
}

export interface TypeInfo {
  type: string;
  /** Friendly name: NeverSink's own section title for the first block of the type. */
  label: string;
  /** NeverSink's table-of-contents number of the first block, like 4000. */
  toc: number;
  group: string;
  tiers: TierInfo[];
}

export interface CatalogItem {
  name: string;
  /** Where the item lands for a single drop at area level 83. */
  type: string;
  tier: string;
  class?: string;
  rarity?: ItemProps['rarity'];
  hidden: boolean;
  style: LabelStyle;
  /** Line of the deciding block. */
  line: number;
}

export interface Catalog {
  types: TypeInfo[];
  items: CatalogItem[];
  byName: Map<string, CatalogItem>;
  tierByKey: Map<string, TierInfo>;
  blocks: Block[];
}


const cap = (s: string): string => (s ? s[0]!.toUpperCase() + s.slice(1) : s);

const LETTERS = ['S', 'A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J', 'K', 'L', 'M', 'N', 'O'];
const WORDS = ['Top', 'High', 'Good', 'Mid', 'Low', 'Lowest'];

const VOCAB = ('high low any other others stack stacked custom ex mis over qual quality level lvl early base bases rare rares magic normal large medium small tiny mirror mirrored top general jewel jewels jewellery abyss corrupted uncorrupted fractured veiled flask flasks utility life mana boots gloves helmet shield shields quiver quivers body armour armours weapon weapons caster attack minion ring rings amulet amulets belt belts exotic delve incursion bestiary warband mercenary essence essences unique uniques special multi hide hideable final rest act link links socket sockets map maps deco decor zone mapup implicit mod enchanted handpicked portal wisdom scroll fragments phys physical pure ele fire cold light lightning chaos focus defense es dot crit spell core exalter blend bleed double single tincture perfection overquality anointed crucible talisman heist ritual lake kala expedition pearl sacrificial stygian mirage first areas under drop decogems vaal gem staves wand sling relic relics key keys safe itemized leagues ultimatum sanctum ilvl corruption resist resists great greater sample optimal very the not and non no yes one two three four five six rgb sockets cluster eco mixer dual hit speed traps elemental glove gloves helm chest random necropolis craft valuable synth imbued void stones trinket fishing rods pieces items kamasan totemic noble burial conqueror idols idol minor enshrouded gear fract jwlry four linked eco tink misc non fractured veil duo').split(' ').sort((a, b) => b.length - a.length);

/** `highstack` as "High stack", `weapon_phys` as "Weapon phys". Cosmetic: a tag the word list does not fully cover stays as written. */
function words(tag: string): string {
  const out: string[] = [];
  for (const part of tag.split(/[_\s]+/).filter(Boolean)) {
    const n = part.length;
    const best: (number[] | null)[] = Array.from({ length: n + 1 }, () => null);
    best[0] = [];
    for (let i = 0; i < n; i++) {
      const here = best[i];
      if (!here) continue;
      const rest = part.slice(i);
      const hops: number[] = [];
      const num = /^\d+/.exec(rest);
      if (num) hops.push(num[0].length);
      for (const w of VOCAB) if (rest.startsWith(w)) hops.push(w.length);
      for (const h of hops) {
        const cur = best[i + h];
        if (!cur || here.length + 1 < cur.length) best[i + h] = [...here, i + h];
      }
    }
    const cuts = best[n];
    if (!cuts) {
      out.push(part);
      continue;
    }
    let a = 0;
    for (const cut of cuts) {
      out.push(part.slice(a, cut));
      a = cut;
    }
  }
  return out.join(' ');
}

const SPECIAL_TIERS: Record<string, string> = { tportal: 'Supplies · Portal scroll', twisdom: 'Supplies · Wisdom scroll', scrollfragments: 'Supplies · Scroll fragments' };

/**
 * A tier tag as a readable name. Numbered tags follow the design: `t1...` is "S tier · Top", `t2...` "A tier · High",
 * on down to "E tier · Lowest". Two tags with the same number get their own suffix so the names stay apart.
 */
export function tierLabel(tier: string, number: number, withSuffix = false): string {
  const m = /^t(\d+)(.*)$/.exec(tier);
  if (m) {
    const r = Math.max(0, Number(m[1]) - 1);
    const letter = LETTERS[r] ?? `T${m[1]}`;
    const word = WORDS[r];
    const extra = cleanWords(m[2]!) ?? words(m[2]!);
    return `${letter} tier${word ? ` · ${word}` : ''}${withSuffix && extra ? ` (${extra})` : ''}`;
  }
  if (SPECIAL_TIERS[tier]) return SPECIAL_TIERS[tier]!;
  if (tier === 'restex') return 'Everything else';
  if (tier === 'exhide') return 'Hidden by NeverSink';
  if (tier === 'any') return 'Any';
  return cap(cleanWords(tier) ?? words(tier)) || `Tier ${number}`;
}

/**
 * The name a tier carries on screen. A tag made of ordinary words reads as those words. A tag that holds a code
 * ("qualchancing", "deco_mapup_t16", "armors1q1") is named from what the tier matches instead, so no raw key
 * reaches the player. `more` adds the secondary conditions, to tell apart tiers that otherwise read the same.
 */
export function tierNameFor(tier: string, number: number, blocks: Block[], more = false): string {
  const m = /^t(\d+)(.*)$/.exec(tier);
  const first = blocks[0];
  const bases = [...new Set(blocks.flatMap(exactNames))];
  if (m) {
    if (!m[2] || cleanWords(m[2]) !== null || !first) return tierLabel(tier, number);
    const r = Math.max(0, Number(m[1]) - 1);
    const letter = LETTERS[r] ?? `T${m[1]}`;
    const word = WORDS[r];
    return `${letter} tier${word ? ` · ${word}` : ''}, ${describeTier(first, bases, more).toLowerCase()}`;
  }
  if (SPECIAL_TIERS[tier] || tier === 'restex' || tier === 'exhide' || tier === 'any' || cleanWords(tier) !== null || !first) return tierLabel(tier, number);
  const base = describeTier(first, bases, more);
  return /^deco/.test(tier) ? `${base}, decorated` : base;
}

/** Types whose blocks name exact item bases the player recognises (not gear rules). */
const ITEM_TYPES = /^(currency|divination|uniques|maps|fragments|gems|vials|corpses|runesgrafts|charts|miscmapitems|heist->contract|heist->blueprint|expedition|exoticmap|questlike|artefact->misc|enshrouded)/;

function sectionTitle(sec: string | undefined): { toc: number; title: string } {
  if (!sec) return { toc: 0, title: '' };
  const m = /^(\d+)\s+(.*)$/.exec(sec);
  return m ? { toc: Number(m[1]), title: m[2]! } : { toc: 0, title: sec };
}

function exactNames(b: Block): string[] {
  const c = b.conditions.find((x) => x.key === 'BaseType');
  if (!c) return [];
  return c.values;
}

/** An item as the block that lists it would describe it, plus defaults for a single drop in a high-level map. */
function propsFor(name: string, from: Block, areaLevel: number): ItemProps {
  const cls = from.conditions.find((c) => c.key === 'Class');
  const rar = from.conditions.find((c) => c.key === 'Rarity');
  const unique = from.tag?.type.startsWith('uniques');
  const rarity = (rar && rar.values.length === 1 && ['Normal', 'Magic', 'Rare', 'Unique'].includes(rar.values[0]!) ? rar.values[0] : unique ? 'Unique' : rar ? rar.values[0] : undefined) as ItemProps['rarity'];
  const p: ItemProps = { name, areaLevel, itemLevel: 80, stackSize: 1, quality: 0, identified: true, corrupted: false, mirrored: false, linkedSockets: 0, sockets: '' };
  if (cls?.values[0]) p.class = cls.values[0];
  if (rarity) p.rarity = rarity;
  const mt = from.conditions.find((c) => c.key === 'MapTier');
  if (mt) p.mapTier = Number(mt.values[0]) || 1;
  return p;
}

export function buildCatalog(blocks: Block[], opts: { areaLevel?: number } = {}): Catalog {
  const areaLevel = opts.areaLevel ?? 83;
  const typeMap = new Map<string, TypeInfo>();
  const tierByKey = new Map<string, TierInfo>();
  const tierBlocks = new Map<string, Block[]>();
  for (const b of blocks) {
    if (!b.tag) continue;
    let t = typeMap.get(b.tag.type);
    const sec = sectionTitle(b.section);
    if (!t) {
      t = { type: b.tag.type, label: sec.title || b.tag.type, toc: sec.toc, group: sectionOfType(b.tag.type).group, tiers: [] };
      typeMap.set(b.tag.type, t);
    }
    const k = tagKey(b.tag);
    let ti = tierByKey.get(k);
    if (!ti) {
      ti = {
        key: k,
        type: b.tag.type,
        tier: b.tag.tier,
        number: t.tiers.length + 1,
        label: tierLabel(b.tag.tier, t.tiers.length + 1),
        kind: b.kind,
        style: blockStyle(b),
        items: [],
        lines: [],
        section: b.section ?? '',
        conditional: false,
      };
      t.tiers.push(ti);
      tierByKey.set(k, ti);
    } else if (ti.kind === 'Hide' && b.kind !== 'Hide') {
      ti.kind = b.kind;
      ti.style = blockStyle(b);
    }
    ti.lines.push(b.line);
    const tb = tierBlocks.get(k);
    if (tb) tb.push(b);
    else tierBlocks.set(k, [b]);
    for (const n of exactNames(b)) if (!ti.items.includes(n)) ti.items.push(n);
    if (b.conditions.some((c) => c.key !== 'Class' && c.key !== 'BaseType')) ti.conditional = true;
  }

  // Where each recognisable item lands.
  const firstBlock = new Map<string, Block>();
  for (const b of blocks) {
    if (!b.tag || !ITEM_TYPES.test(b.tag.type)) continue;
    for (const n of exactNames(b)) if (!firstBlock.has(n)) firstBlock.set(n, b);
  }
  const items: CatalogItem[] = [];
  const byName = new Map<string, CatalogItem>();
  for (const [name, from] of firstBlock) {
    const props = propsFor(name, from, areaLevel);
    const r = evaluateItem(blocks, props, { areaLevel, steps: false });
    const d = r.decided;
    const it: CatalogItem = {
      name,
      type: d?.tag?.type ?? from.tag!.type,
      tier: d?.tag?.tier ?? from.tag!.tier,
      hidden: !r.visible,
      style: r.style,
      line: d?.line ?? from.line,
      ...(props.class ? { class: props.class } : {}),
      ...(props.rarity ? { rarity: props.rarity } : {}),
    };
    items.push(it);
    byName.set(name, it);
  }
  // Names come from the tag when it is made of words, else from what the tier matches. Two tiers of one type
  // that read the same get their secondary conditions, then their suffix, so the names stay apart.
  for (const t of typeMap.values()) {
    for (const ti of t.tiers) ti.label = tierNameFor(ti.tier, ti.number, tierBlocks.get(ti.key) ?? []);
    const dup = (): TierInfo[][] => {
      const seen = new Map<string, TierInfo[]>();
      for (const ti of t.tiers) {
        const l = seen.get(ti.label);
        if (l) l.push(ti);
        else seen.set(ti.label, [ti]);
      }
      return [...seen.values()].filter((l) => l.length > 1);
    };
    for (const l of dup()) for (const ti of l) ti.label = /^t\d+/.test(ti.tier) ? tierLabel(ti.tier, ti.number, true) : tierNameFor(ti.tier, ti.number, tierBlocks.get(ti.key) ?? [], true);
    for (const l of dup()) l.forEach((ti, i) => { if (i > 0) ti.label = `${ti.label} (${i + 1})`; });
  }
  return { types: [...typeMap.values()], items, byName, tierByKey, blocks };
}

export function tagOf(t: { type: string; tier: string }): TagRef {
  return { type: t.type, tier: t.tier };
}

/**
 * Where an item name turns up, by Customize section: every tier of every type lists the exact base types its
 * blocks carry, so a name that two sections list (a unique base and a currency, say) is found in both.
 * Returns the matching names per section id. Needs two letters.
 */
export function itemSectionHits(cat: Catalog, query: string): Map<string, string[]> {
  const q = query.trim().toLowerCase();
  const out = new Map<string, string[]>();
  if (q.length < 2) return out;
  for (const ty of cat.types) {
    const id = sectionOfType(ty.type).id;
    for (const t of ty.tiers)
      for (const n of t.items)
        if (n.toLowerCase().includes(q)) {
          const l = out.get(id);
          if (!l) out.set(id, [n]);
          else if (!l.includes(n)) l.push(n);
        }
  }
  return out;
}
