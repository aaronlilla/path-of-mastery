/**
 * The player's names for NeverSink's sections. NeverSink's file has about 130 `$type` tags with its own codes
 * ("rare->exarch", "currency->levelingstacked"). The Customize list shows the groups and sections below instead,
 * in the order the design uses. Every `$type` lands in exactly one section; a section can hold several types.
 */

export interface SectionDef {
  id: string;
  name: string;
  group: string;
  /** NeverSink `$type` tags (exact) or patterns that belong here. */
  types: (string | RegExp)[];
  /** Which whole-filter theme scope a section falls under. */
  scope?: 'currency' | 'gear';
  /** Shown when NeverSink has no tags of its own for this section. */
  note?: string;
  /** Open this section instead (the items live in another section's tiers). */
  seeInstead?: string;
}

export const GROUP_ORDER = ['Currency and rewards', 'Your build', 'Endgame (level 68+)', 'Gems, flasks and jewels', 'Leveling', 'Heist and Sanctum', 'Fallbacks'] as const;

const C = 'Currency and rewards';
const E = 'Endgame (level 68+)';
const G = 'Gems, flasks and jewels';
const L = 'Leveling';
const H = 'Heist and Sanctum';
const F = 'Fallbacks';

export const SECTIONS: SectionDef[] = [
  { id: 'currency', name: 'General currency', group: C, scope: 'currency', types: ['currency'] },
  { id: 'othercur', name: 'Other currency', group: C, scope: 'currency', types: ['currency->harvest', 'currency->deadmansulphur', 'currency->others', 'currency->heist', 'currency->leagueexclusive', 'currency->ducats', 'vials', 'runesgrafts', 'corpses', 'exotic->wombgifts'] },
  { id: 'stacked', name: 'Stacked currency', group: C, scope: 'currency', types: [/^currency->stackedsupplies/, 'currency->stackedsix', 'currency->stackedthree'] },
  { id: 'shards', name: 'Shards', group: C, scope: 'currency', types: [/^currency->splinter/, /^currency->stackedsplinters/] },
  { id: 'fossils', name: 'Fossils', group: C, scope: 'currency', types: ['currency->fossil'] },
  { id: 'essences', name: 'Essences', group: C, scope: 'currency', types: ['currency->essence'] },
  { id: 'oils', name: 'Oils', group: C, scope: 'currency', types: ['currency->oil'] },
  { id: 'catalysts', name: 'Catalysts', group: C, scope: 'currency', types: [], seeInstead: 'currency', note: "NeverSink does not keep catalysts in a section of their own. They sit in the General currency tiers, next to the orbs of the same value." },
  { id: 'delirium', name: 'Delirium orbs', group: C, scope: 'currency', types: ['currency->deliriumorbs'] },
  { id: 'tattoos', name: 'Tattoos', group: C, scope: 'currency', types: ['currency->trial->tattoo'] },
  { id: 'omens', name: 'Omens', group: C, scope: 'currency', types: ['currency->trial->omen'] },
  { id: 'cards', name: 'Divination cards', group: C, types: ['divination'] },
  { id: 'uniques', name: 'Unique items', group: C, types: ['uniques', 'uniques->replicas', 'uniques->foulborn'] },
  { id: 'gold', name: 'Gold', group: C, types: ['gold'] },

  { id: 'maps', name: 'Maps by tier', group: E, types: ['maps', 'maps->blighted', 'maps->vaaltemple', 'maps->corruptedspecial', 'maps->enchanted', 'uniques->maps'] },
  { id: 'minf', name: 'Influenced maps', group: E, types: ['maps->influenced'] },
  { id: 'valdo', name: "Valdo's boxes", group: E, types: ['maps->nightmare'] },
  { id: 'scarabs', name: 'Scarabs', group: E, types: ['fragments->scarabs', 'fragments->stacked'] },
  { id: 'fragments', name: 'Fragments', group: E, types: ['fragments', 'miscmapitems', 'miscmapitemsextra', 'charts', 'expedition->logbook'] },
  { id: 'gear', name: 'Crafting bases', group: E, scope: 'gear', types: [/^crafting->/, 'gear->memorystrand'] },
  { id: 'idmod', name: 'Rare gear, ID mod filtering', group: E, scope: 'gear', types: ['rareid', 'rareblendid', 'magicid', 'corruptedid', 'rr', /^rr->/] },
  { id: 'exotic', name: 'Exotic bases', group: E, types: ['exoticbases', 'exoticbaseslower', 'exoticmods', /^exotic->/, /^rare->/, 'influenced->all', /^decorators->rareeg/, /^artefact->misc/, 'questlikeexception', 'enshrouded', 'event->idols'] },

  { id: 'gems', name: 'Exceptional gems', group: G, types: ['gems->exceptional'] },
  { id: 'gq', name: 'Quality gems', group: G, types: ['gems->special', 'gems->generic'] },
  { id: 'flasks', name: 'Flasks and tinctures', group: G, types: ['endgameflasks', 'endgametinctures', /^leveling->flasks/, 'leveling->tincture'] },
  { id: 'abyss', name: 'Abyss jewels', group: G, types: ['jewels->abyss'] },
  { id: 'cluster', name: 'Cluster jewels', group: G, types: ['jewels->cluster', 'jewels->clustereco'] },
  { id: 'jewels', name: 'Other jewels', group: G, types: ['jewels->special', 'jewels->generic', 'jewels->leveling'] },

  { id: 'links', name: 'Links and sockets', group: L, scope: 'gear', types: ['6l', 'socketslinks', 'leveling->rare->socketslinks'] },
  { id: 'lcur', name: 'Leveling currency', group: L, types: ['currency->leveling', 'currency->levelingstacked'] },
  { id: 'act', name: 'Act 1 to 10 gear', group: L, types: [/^leveling->/, /^decorators->leveling/] },

  { id: 'heist', name: 'Heist', group: H, types: [/^heist->/, 'heisttarget', 'uniques->heist'] },
  { id: 'sanctum', name: 'Sanctum', group: H, types: ['exoticmap->sanctum', 'artefact->sanctifiedrelics'] },

  { id: 'remain', name: 'Remaining items', group: F, types: ['anyremaining', 'questlike'] },
  { id: 'hideall', name: 'Hide-all fallback', group: F, types: ['hidelayer'] },
];

/** Plain names for the types whose NeverSink titles are shared or unclear. */
const TYPE_NAMES: Record<string, string> = {
  'currency->harvest': 'Lifeforce',
  'currency->deadmansulphur': "Dead Man's sulphur",
  'currency->others': 'Scrying orbs, lenses and imprints',
  'currency->heist': 'Heist coins',
  'currency->leagueexclusive': 'League coins',
  'currency->ducats': 'Allflame ducats',
  vials: 'Vials',
  runesgrafts: 'Runes',
  corpses: 'Corpses',
  'exotic->wombgifts': 'Wombgifts',
  'currency->stackedsix': 'Stacks of 6',
  'currency->stackedthree': 'Stacks of 3',
  'rare->exarch': 'Eldritch items, Searing Exarch',
  'rare->eater': 'Eldritch items, Eater of Worlds',
  exoticbases: 'Exotic bases',
  exoticbaseslower: 'Exotic bases, lower value',
};

/** The name to show above a type's tiers when a section holds several. */
export function typeName(type: string, nsLabel: string): string {
  return TYPE_NAMES[type] ?? nsLabel.replace(/\s*-\s*/g, ' · ');
}

const matches = (t: string, p: string | RegExp): boolean => (typeof p === 'string' ? p === t : p.test(t));

/** The section a NeverSink `$type` belongs to. A type no list names lands in Remaining items. */
export function sectionOfType(type: string): SectionDef {
  return SECTIONS.find((s) => s.types.some((p) => matches(type, p))) ?? SECTIONS.find((s) => s.id === 'remain')!;
}

/** True when some list names the type (so tests can see which types fell through). */
export function isNamedType(type: string): boolean {
  return SECTIONS.some((s) => s.types.some((p) => matches(type, p)));
}

/** Which whole-filter theme scope a NeverSink `$type` falls under. */
export function themeScopeOfType(type: string | undefined): 'currency' | 'gear' | 'other' {
  if (!type) return 'other';
  return sectionOfType(type).scope ?? 'other';
}
