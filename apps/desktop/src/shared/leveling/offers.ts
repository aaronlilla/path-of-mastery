/**
 * Gem offers: who sells or rewards which gem at what level, joined by gemId. Pure. The compact file
 * (resources/leveling/<league>/gem-offers.json, written by scripts/leveling-refresh.mjs) is expanded here.
 */
import type { GemMeta, GemOffer, LevelingData, OfferKind } from './types.js';

export const CLASS_LETTER: Record<string, string> = { Marauder: 'M', Duelist: 'D', Ranger: 'R', Shadow: 'S', Witch: 'W', Templar: 'T', Scion: 'X' };
const CLASS_BY_LETTER: Record<string, string> = Object.fromEntries(Object.entries(CLASS_LETTER).map(([k, v]) => [v, k]));

type OfferRow = [OfferKind, string, number, string, number, string];
export interface GemOffersFile {
  meta?: Record<string, unknown>;
  startingGems: Record<string, { start: string; chest: string }>;
  gems: Record<string, { n: string; s: 0 | 1; c: string; o: OfferRow[]; w?: string[]; t?: string[] }>;
}

export interface ExpandedOffers {
  offers: LevelingData['offers'];
  gems: LevelingData['gems'];
  starts: LevelingData['starts'];
}

/** Compact file to per-gem, per-class offers. Start and chest gems become level 1 offers. */
export function expandOffers(file: GemOffersFile): ExpandedOffers {
  const offers: LevelingData['offers'] = {};
  const gems: LevelingData['gems'] = {};
  for (const [gemId, g] of Object.entries(file.gems)) {
    const meta: GemMeta = { name: g.n, isSupport: g.s === 1, colour: g.c };
    if (g.w) meta.weaponTypes = g.w;
    if (g.t) meta.tags = g.t;
    gems[gemId] = meta;
    const byClass: Record<string, GemOffer[]> = {};
    for (const [kind, questId, act, npc, level, cls] of g.o) {
      const list = cls === '*' ? Object.keys(CLASS_LETTER) : [...cls].map((l) => CLASS_BY_LETTER[l]).filter((c): c is string => !!c);
      for (const c of list) (byClass[c] ??= []).push({ gemId, class: c, kind, questId, act, npc, level });
    }
    offers[gemId] = byClass;
  }
  for (const [c, v] of Object.entries(file.startingGems)) {
    for (const [kind, gemId] of [['start', v.start], ['chest', v.chest]] as const) {
      if (!gemId) continue;
      ((offers[gemId] ??= {})[c] ??= []).push({ gemId, class: c, kind, questId: '', act: 0, npc: '', level: 1 });
    }
  }
  return { offers, gems, starts: file.startingGems };
}

const KIND_ORDER: Record<OfferKind, number> = { start: 0, chest: 1, quest: 2, vendor: 3, siosa: 4, lilly: 5 };
const RUTHLESS_KINDS = new Set<OfferKind>(['start', 'chest', 'quest']);

/** The offers of `gemId` that `className` can use, earliest first. Ruthless keeps start, chest and quest offers. */
export function offersFor(data: Pick<LevelingData, 'offers'>, gemId: string, className: string, ruthless: boolean): GemOffer[] {
  const list = data.offers[gemId]?.[className] ?? [];
  return list
    .filter((o) => !ruthless || RUTHLESS_KINDS.has(o.kind))
    .slice()
    .sort((a, b) => a.level - b.level || a.act - b.act || KIND_ORDER[a.kind] - KIND_ORDER[b.kind]);
}

/** `avail(gemId, class)`: the earliest offer, or null when the class cannot get the gem from NPCs. */
export function avail(data: Pick<LevelingData, 'offers'>, gemId: string, className: string, ruthless: boolean): GemOffer | null {
  return offersFor(data, gemId, className, ruthless)[0] ?? null;
}

// ---- resolving a build's gem to a gemId ----

export interface EngineGemRecord {
  gameId?: string;
  baseTypeName?: string;
  name?: string;
  grantedEffect?: { id?: string };
}

export interface GemIndex {
  /** Any engine key or game id to the canonical gemId the offers use. */
  canon: Map<string, string>;
  bySkillId: Map<string, string>;
  /** lower-case display name to canonical gemId */
  byName: Map<string, string>;
  /** canonical gemId of a Vaal gem's base gem is the same gem: Vaal records map to their base. */
}

const ALT = /Alt[XYZ]$/;
/** Display names before the 3.29 renames, for builds saved with the old name only. */
const RENAMED: Record<string, string> = {
  'poison arrow': 'caustic arrow',
  'magma orb': 'rolling magma',
  sanctify: 'purifying flame',
  'shrapnel shot': 'galvanic arrow',
  'shrapnel trap': 'explosive trap',
  'frost bolt': 'frostbolt',
};

/**
 * The quest tables name a gem by its game id for some gems (Caustic Arrow is `SkillGemPoisonArrow`) and by the engine record key
 * for others (`SkillGemArcticArmour`, game id `SkillGemNewArcticArmour`). A transfigured gem shares the game id of its base,
 * so it lands on the base gem. `offerIds` is the set of gemIds the offers file knows.
 */
export function buildGemIndex(records: Record<string, EngineGemRecord>, offerIds: Iterable<string>): GemIndex {
  const known = new Set(offerIds);
  const groups = new Map<string, string[]>();
  for (const [key, r] of Object.entries(records)) {
    const g = r.gameId || key;
    (groups.get(g) ?? groups.set(g, []).get(g)!).push(key);
  }
  const canon = new Map<string, string>();
  const canonOfGroup = new Map<string, string>();
  for (const [gameId, keys] of groups) {
    const base = keys.filter((k) => !ALT.test(k));
    const pick = [gameId, ...base, ...keys].find((id) => known.has(id)) ?? gameId;
    canonOfGroup.set(gameId, pick);
    canon.set(gameId, pick);
    for (const k of keys) canon.set(k, pick);
  }
  const bySkillId = new Map<string, string>();
  const byName = new Map<string, string>();
  for (const [key, r] of Object.entries(records)) {
    const c = canon.get(key);
    if (!c) continue;
    const sid = r.grantedEffect?.id;
    if (sid && !bySkillId.has(sid)) bySkillId.set(sid, c);
    const alt = ALT.test(key);
    for (const n of [r.baseTypeName, r.name]) {
      if (!n) continue;
      const l = n.toLowerCase();
      // base records win a name; a transfigured name still resolves to its base gem
      if (!byName.has(l) || !alt) byName.set(l, c);
    }
  }
  return { canon, bySkillId, byName };
}

/**
 * The `<Gem>` element's identity, in the order of the design: the gemId attribute, then skillId, then nameSpec.
 * Vaal gems resolve to their base gem. Returns null when none of the three is known.
 */
export function resolveGem(attrs: { gemId?: string; skillId?: string; nameSpec?: string }, idx: GemIndex): string | null {
  const strip = (id: string) => (/^Metadata\/Items\/Gems\/SkillGemVaal/.test(id) ? id.replace('SkillGemVaal', 'SkillGem') : id);
  if (attrs.gemId) {
    const c = idx.canon.get(attrs.gemId) ?? idx.canon.get(strip(attrs.gemId));
    if (c) return idx.canon.get(strip(c)) ?? c;
  }
  if (attrs.skillId) {
    // an old skillId is still the tail of the game id (PoisonArrow -> SkillGemPoisonArrow, now Caustic Arrow)
    const c = idx.bySkillId.get(attrs.skillId) ?? idx.canon.get('Metadata/Items/Gems/SkillGem' + attrs.skillId);
    if (c) return c;
  }
  if (attrs.nameSpec) {
    const n = attrs.nameSpec.toLowerCase().replace(/^vaal /, '').replace(/^awakened /, '');
    const c = idx.byName.get(RENAMED[n] ?? n) ?? idx.byName.get((RENAMED[n] ?? n) + ' support');
    if (c) return c;
  }
  return null;
}
